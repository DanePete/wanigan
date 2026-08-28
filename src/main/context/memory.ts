import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Auto memory — what is actually in the agent's head at session start.
 *
 * Claude Code keeps a per-project memory directory and loads MEMORY.md from it
 * when a session starts. That load is capped: the first 200 lines or 25 KB,
 * whichever comes first. Nothing warns when the cap is reached. The index keeps
 * growing, the tail quietly stops being read, and the agent forgets things it
 * "remembered" last week. The limit is invisible in normal use — you cannot see
 * it from the CLI, from the file, or from the transcript — which is the entire
 * reason it is worth a panel.
 *
 * Two more facts shape what is reported here:
 *  - Topic files are NOT loaded at startup. Claude opens one when it decides it
 *    needs it, so fifty memories do not cost fifty files of context per session.
 *  - The directory is keyed off the GIT REPOSITORY, not the working directory,
 *    so every worktree and subdirectory of one repo shares one memory directory.
 *    A worktree showing an empty panel is nearly always looking for memories
 *    that are filed under the main checkout's slug.
 *
 * Everything below is read-only and synchronous: the panel polls, and a memory
 * directory is a few dozen small markdown files.
 */

/* ── the verified limits ─────────────────────────────────────────────── */

/**
 * MEMORY.md is an index and only its head reaches the model: the first 200
 * lines OR 25 KB, whichever comes first. Everything past the cut is silently
 * dropped on the next load.
 */
export const INDEX_LINE_LIMIT = 200;
/**
 * 25 KB taken as 25 KiB. If the CLI means 25,000 bytes the cut lands about 2%
 * earlier, so an index sitting on the line should be treated as over it — this
 * is a budget to stay clear of, not one to fill exactly.
 */
export const INDEX_BYTE_LIMIT = 25 * 1024;

const HOME = os.homedir();
/** The default home for auto memory: ~/.claude/projects/<slug>/memory. */
const PROJECTS_ROOT = path.join(HOME, '.claude', 'projects');

/** Never pull a whole file into the main process; memories are prose, not logs. */
const SCAN_MAX = 2 * 1024 * 1024;
/** What the reading pane gets. Large enough for any real memory file. */
const BODY_MAX = 200 * 1024;

/* ── shape ───────────────────────────────────────────────────────────── */

export type MemoryKind = 'user' | 'feedback' | 'project' | 'reference' | 'unknown';

export type MemoryFile = {
  name: string;
  path: string;
  kind: MemoryKind;
  description: string;
  bytes: number;
  lines: number;
  modified: number;
  /** ISO timestamp Claude Code writes into frontmatter, when present. */
  modifiedFrontmatter: string | null;
  /**
   * Links found in the body as [[other-memory]] — and, in the index, also as
   * the plain markdown [Title](other-memory.md) form it is actually written
   * with — resolved where possible.
   */
  links: { name: string; exists: boolean }[];
  isIndex: boolean;
};

export type MemoryState = {
  dir: string;
  exists: boolean;
  enabled: boolean;
  /** Why the directory is where it is: git root, project root, or an override. */
  derivedFrom: 'git-repo' | 'project-root' | 'setting-override';
  index: MemoryFile | null;
  /** The MEMORY.md budget, which is the whole point of this panel. */
  indexBudget: {
    lines: number; lineLimit: number;
    bytes: number; byteLimit: number;
    loadedLines: number; droppedLines: number;
    overBudget: boolean; note: string;
  } | null;
  files: MemoryFile[];
  counts: Record<MemoryKind, number>;
  /** Memories referenced by [[link]] that have no file yet. */
  danglingLinks: string[];
  orphans: string[];
  notes: string[];
};

/* ── settings layers ─────────────────────────────────────────────────── */

/**
 * Claude Code's own settings, lowest precedence first. Managed policy wins over
 * everything, which is why it is read last. Wanigan's SQLite settings are a
 * different thing entirely and deliberately not consulted: the question here is
 * what the *CLI* will do, not what Wanigan would like it to do.
 */
function settingsLayers(projectPath: string): { layer: string; file: string }[] {
  const managed = process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : '/etc/claude-code/managed-settings.json';
  return [
    { layer: 'user', file: path.join(HOME, '.claude', 'settings.json') },
    { layer: 'project', file: path.join(projectPath, '.claude', 'settings.json') },
    { layer: 'project local', file: path.join(projectPath, '.claude', 'settings.local.json') },
    { layer: 'managed policy', file: managed },
  ];
}

/**
 * Parse failures are collected per call rather than in a module-level list:
 * a broken settings file in one project must not show up in another project's
 * notes, and must clear the moment it is fixed.
 */
function readJson(file: string, bad?: string[]): Record<string, unknown> | null {
  let raw: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    raw = fs.readFileSync(file, 'utf8');
  } catch { return null; }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A settings file the CLI cannot parse is a settings file the CLI ignores.
    // Say so rather than silently reporting defaults as if they were chosen.
    if (bad && !bad.includes(file)) bad.push(file);
    return null;
  }
}

/** The winning value for a key, and the layer it came from. */
function settingValue(
  projectPath: string,
  key: string,
  bad?: string[],
): { value: unknown; layer: string; file: string } | null {
  let win: { value: unknown; layer: string; file: string } | null = null;
  for (const l of settingsLayers(projectPath)) {
    const json = readJson(l.file, bad);
    if (json && key in json && json[key] !== undefined && json[key] !== null) {
      win = { value: json[key], layer: l.layer, file: l.file };
    }
  }
  return win;
}

/**
 * autoMemoryDirectory is documented as absolute or ~/-prefixed. A relative value
 * is resolved against the project rather than the process cwd: Wanigan's cwd is
 * wherever the app bundle launched from, which would send the panel somewhere
 * the user could not explain.
 */
function expandHome(p: string, base: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return path.resolve(base, p);
}

/* ── where the memories live ─────────────────────────────────────────── */

/**
 * Claude Code derives <project> by replacing every non-alphanumeric character
 * with '-'. Case is preserved, and the leading '/' becomes a leading '-'.
 */
export function slugForPath(p: string): string {
  return path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Whether git *ran*, kept separate from what it said. Collapsing the two is how
 * the panel came to state "not inside a git repository" as a fact about the
 * filesystem when all that happened was that a subprocess failed.
 */
type GitResult =
  | { ok: true; out: string | null }
  | { ok: false; why: string };

function git(dir: string, args: string[]): GitResult {
  try {
    // Sync on purpose: readMemory's signature is sync, and this is a handful of
    // milliseconds cached for 30s rather than a spawn per renderer poll.
    const out = execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const t = out.trim();
    return { ok: true, out: t || null };
  } catch (e) {
    const err = e as { code?: unknown; status?: unknown; signal?: unknown; message?: unknown };
    // An Electron app launched from Finder inherits a minimal PATH, not the
    // login shell's, so a missing binary here is routine rather than exotic.
    if (err.code === 'ENOENT') return { ok: false, why: 'git is not on the PATH this app inherits' };
    if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') {
      return { ok: false, why: 'git did not answer within 4 seconds' };
    }
    // A non-zero exit is git ANSWERING: rev-parse outside a repository exits
    // 128, and that is a real "no", not a failure to ask.
    if (typeof err.status === 'number') return { ok: true, out: null };
    return { ok: false, why: typeof err.message === 'string' ? err.message : String(e) };
  }
}

/**
 * The trimmed output, or null when git either failed or printed nothing. Only
 * safe where both cases lead to the same fallback anyway.
 */
function gitOut(dir: string, args: string[]): string | null {
  const r = git(dir, args);
  return r.ok ? r.out : null;
}

type Repo = {
  /** The repository every worktree of it shares. */
  root: string;
  /** Set only when `dir` is a linked worktree, whose own root differs. */
  worktree: string | null;
};

/**
 * `unavailable` is set only when git could not be run or did not finish. A null
 * repo with a null `unavailable` is git's own answer that this is not a repo;
 * the caller must not report the two the same way.
 */
type RepoLookup = { repo: Repo | null; unavailable: string | null };

const repoCache = new Map<string, { at: number; value: RepoLookup }>();
const REPO_TTL_MS = 30_000;

function repoFor(dir: string): RepoLookup {
  const hit = repoCache.get(dir);
  if (hit && Date.now() - hit.at < REPO_TTL_MS) return hit.value;

  let value: RepoLookup = { repo: null, unavailable: null };
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    value = { repo: null, unavailable: top.why };
  } else if (top.out) {
    // --show-toplevel inside a linked worktree returns the *worktree*, not the
    // repository. The common dir is what all worktrees share, so its parent is
    // the root whose slug owns the memories.
    let common = gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      ?? gitOut(dir, ['rev-parse', '--git-common-dir']);
    if (common && !path.isAbsolute(common)) common = path.resolve(dir, common);
    const main = common && path.basename(common) === '.git' ? path.dirname(common) : top.out;
    value = { repo: { root: main, worktree: main === top.out ? null : top.out }, unavailable: null };
  }
  repoCache.set(dir, { at: Date.now(), value });
  return value;
}

/** Directories readMemory has actually resolved, so memoryBody can refuse the rest. */
const knownDirs = new Set<string>();

function defaultDirFor(root: string): string {
  return path.join(PROJECTS_ROOT, slugForPath(root), 'memory');
}

export function memoryDirFor(projectPath: string): { dir: string; derivedFrom: MemoryState['derivedFrom'] } {
  const abs = path.resolve(projectPath);

  const override = settingValue(abs, 'autoMemoryDirectory');
  if (typeof override?.value === 'string' && override.value.trim()) {
    const dir = expandHome(override.value.trim(), abs);
    knownDirs.add(dir);
    return { dir, derivedFrom: 'setting-override' };
  }

  const repo = repoFor(abs).repo;
  if (!repo) {
    // Outside a repo — or with no way to ask git — the working directory itself
    // is the only project root available. readMemory says which of the two it
    // was, because they are not the same claim.
    const dir = defaultDirFor(abs);
    knownDirs.add(dir);
    return { dir, derivedFrom: 'project-root' };
  }

  let dir = defaultDirFor(repo.root);
  // If this is a worktree and the shared directory does not exist but the
  // worktree's own does, report what is actually on disk rather than a guess.
  if (repo.worktree && !fs.existsSync(dir) && fs.existsSync(defaultDirFor(repo.worktree))) {
    dir = defaultDirFor(repo.worktree);
  }
  knownDirs.add(dir);
  return { dir, derivedFrom: 'git-repo' };
}

/* ── frontmatter ─────────────────────────────────────────────────────── */

type Front = Record<string, string>;

/**
 * A deliberately small YAML reader. Memory frontmatter is a flat map plus one
 * nested `metadata:` block, and a real parser would be a dependency bought to
 * read four keys. Nested keys are flattened to `metadata.type`; anything it
 * does not understand is skipped rather than guessed at.
 */
function parseFrontmatter(text: string): Front {
  if (!text.startsWith('---')) return {};
  const firstNl = text.indexOf('\n', 3);
  const end = text.indexOf('\n---', 3);
  if (firstNl === -1 || end === -1 || end < firstNl) return {};
  const block = text.slice(firstNl + 1, end);

  const out: Front = {};
  let key: string | null = null;
  let nested = false;
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top && !/^\s/.test(line)) {
      key = top[1];
      const v = unquote(top[2]);
      // A key with no value opens a nested block; a key with one can still be
      // continued by wrapped lines beneath it.
      nested = v === '';
      out[key] = v;
      continue;
    }
    if (!key || !/^\s+\S/.test(line)) continue;

    const child = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (nested && child) { out[`${key}.${child[1]}`] = unquote(child[2]); continue; }
    // A folded continuation belongs to the key above it: dropping it truncates
    // a wrapped description mid-sentence.
    if (!nested) out[key] = (out[key] ? out[key] + ' ' : '') + unquote(line.trim());
  }
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

const KINDS = new Set<string>(['user', 'feedback', 'project', 'reference']);

function kindOf(fm: Front): MemoryKind {
  const t = (fm['metadata.type'] || fm.type || '').trim().toLowerCase();
  return KINDS.has(t) ? (t as MemoryKind) : 'unknown';
}

/**
 * `modified` is written into frontmatter by Claude Code v2.1.214 and later, so
 * an older memory legitimately has none — the file mtime is then the only date
 * there is, and pretending otherwise would invent history.
 */
function frontmatterModified(fm: Front): string | null {
  const v = (fm['metadata.modified'] || fm.modified || '').trim();
  return /^\d{4}-\d{2}-\d{2}T/.test(v) ? v : null;
}

/* ── body reading ────────────────────────────────────────────────────── */

/**
 * Read at most `max` bytes. readFileSync would pull the whole file into the
 * main process, and a memory directory is not guaranteed to hold only prose —
 * one stray log redirected into it must not take the app down. A cut can land
 * mid-codepoint, which costs one replacement character at the very end and
 * nothing else.
 */
function readHead(file: string, max: number, size: number): { text: string; complete: boolean } {
  const fd = fs.openSync(file, 'r');
  try {
    const want = Math.min(max, Math.max(size, 0));
    const buf = Buffer.allocUnsafe(want);
    const n = want > 0 ? fs.readSync(fd, buf, 0, want, 0) : 0;
    return { text: buf.subarray(0, n).toString('utf8'), complete: size <= max };
  } finally { fs.closeSync(fd); }
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  const after = text.indexOf('\n', end + 1);
  return after === -1 ? '' : text.slice(after + 1);
}

/** A trailing newline does not start a line. */
function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

/**
 * Code fences and code spans are stripped before scanning for links: a
 * [[link]] shown as an example inside backticks is documentation, not a link,
 * and counting it invents a dangling memory that nobody meant to reference.
 */
function stripCode(body: string): string {
  return body
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/`[^`\n]*`/g, '');
}

function linkKey(s: string): string {
  return s.trim().replace(/\.md$/i, '').trim().toLowerCase();
}

function linkTargets(body: string): string[] {
  const src = stripCode(stripFrontmatter(body));
  const seen = new Map<string, string>();
  const add = (raw: string) => {
    const name = raw.trim().replace(/\.md$/i, '').trim();
    const key = linkKey(name);
    if (key && !seen.has(key)) seen.set(key, name);
  };

  for (const m of src.matchAll(/\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/g)) add(m[1]);
  // MEMORY.md indexes its topics with the plain markdown form. Treating only
  // [[wiki]] links as links would report the index as linking to nothing and
  // every topic file as an orphan — exactly backwards.
  for (const m of src.matchAll(/\]\(\s*\.?\/?([^()\s#]+\.md)\s*\)/gi)) {
    const t = m[1];
    if (t.includes('://')) continue;
    add(path.basename(t));
  }
  return [...seen.values()];
}

/** Fallback description: the first real sentence of prose. */
function firstProse(text: string): string {
  for (const line of stripFrontmatter(text).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('```') || t.startsWith('>') || t.startsWith('---')) continue;
    return t.length > 240 ? t.slice(0, 237) + '…' : t;
  }
  return '';
}

/* ── the budget ──────────────────────────────────────────────────────── */

function kb(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Where the cut actually falls. A line counts as loaded only if it fits whole
 * inside both limits — a line halved by the byte cap does not reach the model
 * as a usable entry, and rounding it up would report a memory as present when
 * it is not.
 */
function budgetFor(text: string, bytes: number, complete: boolean): NonNullable<MemoryState['indexBudget']> {
  const body = text.replace(/\n$/, '');
  const lines = body === '' ? [] : body.split('\n');
  const total = lines.length;

  let used = 0;
  let loaded = 0;
  let cut: 'lines' | 'bytes' | null = null;
  for (const line of lines) {
    if (loaded >= INDEX_LINE_LIMIT) { cut = 'lines'; break; }
    const cost = Buffer.byteLength(line, 'utf8') + 1;
    if (used + cost > INDEX_BYTE_LIMIT) { cut = 'bytes'; break; }
    used += cost;
    loaded++;
  }

  const dropped = Math.max(0, total - loaded);
  const over = dropped > 0;

  let note: string;
  if (over) {
    const which = cut === 'bytes'
      ? `the 25 KB cap (at line ${loaded + 1})`
      : `the 200-line cap`;
    note =
      `MEMORY.md is ${total} lines / ${kb(bytes)}. Claude Code loads only the first ${loaded} of them ` +
      `at session start — it stops at ${which} — so the last ${dropped} ` +
      `line${dropped === 1 ? '' : 's'} never reach the agent, silently, on every session. ` +
      `The fix is one line per entry in the index, with the detail moved into topic files.`;
  } else {
    const roomLines = INDEX_LINE_LIMIT - total;
    const roomBytes = INDEX_BYTE_LIMIT - used;
    note =
      `MEMORY.md fits: all ${total} lines load (${total}/${INDEX_LINE_LIMIT} lines, ${kb(bytes)}/25 KB). ` +
      `Room for about ${roomLines} more line${roomLines === 1 ? '' : 's'} or ${kb(roomBytes)} ` +
      `before the tail starts being dropped without warning.`;
  }
  if (!complete) {
    note += ` (Only the first ${kb(SCAN_MAX)} of the file was read, so the line count is a floor.)`;
  }

  return {
    lines: total,
    lineLimit: INDEX_LINE_LIMIT,
    bytes,
    byteLimit: INDEX_BYTE_LIMIT,
    loadedLines: loaded,
    droppedLines: dropped,
    overBudget: over,
    note,
  };
}

/* ── the scan ────────────────────────────────────────────────────────── */

type Scanned = { file: MemoryFile; targets: string[]; text: string; complete: boolean };

function scanFile(full: string, notes: string[]): Scanned | null {
  let st: fs.Stats;
  try { st = fs.statSync(full); } catch { return null; }
  if (!st.isFile()) return null;

  let head: { text: string; complete: boolean };
  try {
    head = readHead(full, SCAN_MAX, st.size);
  } catch (e) {
    // openSync throws on a mode-000 or root-owned file, a FIFO, or a device
    // node someone dropped in here. Without this catch that EACCES escapes
    // readMemory entirely and blanks the whole panel — including the MEMORY.md
    // budget, which is the one thing the panel exists to show.
    const why = e instanceof Error ? e.message : String(e);
    notes.push(
      `${path.basename(full)} could not be read (${why}), so it is listed nowhere and its links are not counted. ` +
      `Check its permissions, or move it out of the memory directory.`,
    );
    return null;
  }
  const fm = parseFrontmatter(head.text);
  const base = path.basename(full).replace(/\.md$/i, '');
  const targets = linkTargets(head.text);

  if (!head.complete) {
    notes.push(`${path.basename(full)} is ${kb(st.size)}; only its first ${kb(SCAN_MAX)} were read, so its line count and links are partial.`);
  }

  return {
    text: head.text,
    complete: head.complete,
    file: {
      name: fm.name?.trim() || base,
      path: full,
      kind: kindOf(fm),
      description: fm.description?.trim() || firstProse(head.text) || 'No description.',
      bytes: st.size,
      lines: countLines(head.text),
      modified: st.mtimeMs,
      modifiedFrontmatter: frontmatterModified(fm),
      links: [],
      isIndex: path.basename(full).toUpperCase() === 'MEMORY.MD',
    },
    targets,
  };
}

export function readMemory(projectPath: string): MemoryState {
  const abs = path.resolve(projectPath);
  const { dir, derivedFrom } = memoryDirFor(abs);
  const notes: string[] = [];
  const unparsable: string[] = [];
  const counts: Record<MemoryKind, number> = { user: 0, feedback: 0, project: 0, reference: 0, unknown: 0 };

  const on = autoMemoryEnabled(abs, unparsable);
  if (!on.enabled && on.why) notes.push(on.why);

  const override = settingValue(abs, 'autoMemoryDirectory', unparsable);
  if (derivedFrom === 'setting-override' && override) {
    notes.push(
      `autoMemoryDirectory is set in ${override.layer} settings (${override.file}), so memories are read from ` +
      `${dir} instead of the per-project default under ~/.claude/projects.`,
    );
  }

  const lookup = derivedFrom === 'setting-override' ? null : repoFor(abs);
  const repo = derivedFrom === 'git-repo' ? lookup?.repo ?? null : null;
  if (repo) {
    if (repo.worktree) {
      notes.push(
        `${abs} is a linked worktree of ${repo.root}. Memory is keyed off the repository, not the checkout, ` +
        `so every worktree shares one directory — this one.`,
      );
    } else if (repo.root !== abs) {
      notes.push(
        `Memory is keyed off the git repository root (${repo.root}), not this directory, so every subdirectory ` +
        `and worktree of that repo reads and writes these same memories.`,
      );
    }
  } else if (derivedFrom === 'project-root') {
    // Without this split the panel asserts "not inside a git repository" on the
    // strength of a subprocess that never ran, and then looks for memories under
    // this subdirectory's slug instead of the repo root's — finding none, and
    // telling the user nothing has been remembered when plenty has.
    if (lookup?.unavailable) {
      notes.push(
        `Wanigan could not run git in ${abs} (${lookup.unavailable}), so it cannot tell whether this is inside a ` +
        `repository. Memory is keyed off the repository root, so if it is, the memories are filed under that root's ` +
        `slug and this panel will look empty. Make sure git is on the PATH Wanigan inherits, then reopen the project.`,
      );
    } else {
      notes.push(`${abs} is not inside a git repository, so the project directory itself keys the memory directory.`);
    }
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    notes.push(
      `No memory directory at ${dir}. Claude Code creates it the first time it saves a memory for this project ` +
      `— an empty panel here means nothing has been remembered yet, not that memory is broken.`,
    );
    return {
      dir, exists: false, enabled: on.enabled, derivedFrom,
      index: null, indexBudget: null, files: [], counts,
      danglingLinks: [], orphans: [], notes: notes.concat(settingsNotes(unparsable)),
    };
  }

  // The directory itself may be reached through a symlink (/tmp → /private/tmp
  // on macOS), so compare real paths or every file looks like it lives outside.
  let realDir = dir;
  try { realDir = fs.realpathSync(dir); } catch { /* keep the literal path */ }

  const scanned: Scanned[] = [];
  let subdirs = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const link = e.isSymbolicLink();

    // A symlink's target decides whether this is a file at all.
    let real: string | null = full;
    if (link) {
      try { real = fs.realpathSync(full); } catch { real = null; }
    }

    let isDir = e.isDirectory();
    if (link && real) {
      try { isDir = fs.statSync(full).isDirectory(); } catch { isDir = false; }
    }
    if (isDir) { subdirs++; continue; }
    if (!/\.md$/i.test(e.name)) continue;

    if (link) {
      // A symlink that leaves the memory directory is still read — Claude Code
      // reads it too — but the panel must say the content comes from elsewhere,
      // because editing it edits a file outside the project's memory.
      if (!real) { notes.push(`${e.name} is a broken symlink, so it is listed nowhere and loads nothing.`); continue; }
      if (path.dirname(real) !== realDir) {
        notes.push(`${e.name} is a symlink out of the memory directory, to ${real}. Its content lives there, not here.`);
      }
    }

    const s = scanFile(full, notes);
    if (s) scanned.push(s);
  }
  if (subdirs > 0) {
    notes.push(`${subdirs} subdirector${subdirs === 1 ? 'y was' : 'ies were'} skipped — memories are flat files in this directory.`);
  }

  // Resolve links against the files that exist. Both the filename and the
  // frontmatter name are accepted, because either is what a link is written as.
  const byKey = new Map<string, MemoryFile>();
  for (const s of scanned) {
    byKey.set(linkKey(path.basename(s.file.path)), s.file);
    if (s.file.name) byKey.set(linkKey(s.file.name), s.file);
  }

  const dangling = new Map<string, string>();
  for (const s of scanned) {
    s.file.links = s.targets.map((t) => {
      const exists = byKey.has(linkKey(t));
      if (!exists && !dangling.has(linkKey(t))) dangling.set(linkKey(t), t);
      return { name: t, exists };
    });
  }

  const indexScan = scanned.find((s) => s.file.isIndex) ?? null;
  const index = indexScan?.file ?? null;

  // An orphan is a memory nothing points at: not indexed by MEMORY.md and not
  // linked from any other memory. Together with dangling links, that is how a
  // memory directory rots — the file is still on disk, but Claude has no reason
  // to ever open it again.
  const orphans: string[] = [];
  for (const s of scanned) {
    if (s.file.isIndex) continue;
    const keys = [linkKey(path.basename(s.file.path)), linkKey(s.file.name)];
    const referenced = scanned.some((other) =>
      other !== s && other.targets.some((t) => keys.includes(linkKey(t))));
    if (!referenced) orphans.push(s.file.name);
  }

  // counts covers every file in the directory, MEMORY.md included — it is the
  // shape of what is stored, not of what loads. What loads is indexBudget.
  for (const s of scanned) counts[s.file.kind]++;

  // files includes the index; `index` is the same object, pulled out because it
  // is the only one that costs context at session start.
  const files = scanned.map((s) => s.file).sort((a, b) => {
    if (a.isIndex !== b.isIndex) return a.isIndex ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  let indexBudget: MemoryState['indexBudget'] = null;
  if (index && indexScan) {
    indexBudget = budgetFor(indexScan.text, index.bytes, indexScan.complete);

    // The cruellest version of the budget: a memory the index does list, on a
    // line that never loads. The file is not an orphan on disk, but nothing in
    // the agent's context points at it, so it may as well not exist.
    if (indexBudget.overBudget) {
      const tail = indexScan.text.replace(/\n$/, '').split('\n').slice(indexBudget.loadedLines).join('\n');
      const stranded = linkTargets(tail).filter((t) => byKey.has(linkKey(t)));
      if (stranded.length) {
        const sample = stranded.slice(0, 3).join(', ');
        notes.push(
          `${stranded.length} memor${stranded.length === 1 ? 'y is' : 'ies are'} listed past the cut (${sample}` +
          `${stranded.length > 3 ? ', …' : ''}). The file${stranded.length === 1 ? '' : 's'} still exist, but nothing ` +
          `the agent can see points at them — move them up in the index or nothing will ever read them again.`,
        );
      }
    }
  } else {
    notes.push(`No MEMORY.md in ${dir}, so nothing from this directory is loaded at session start.`);
  }

  const topics = files.length - (index ? 1 : 0);
  if (topics > 0) {
    notes.push(
      `Only MEMORY.md is loaded at session start. The other ${topics} file${topics === 1 ? '' : 's'} ` +
      `cost nothing until Claude decides to read one, so a large memory directory is not a large context bill — ` +
      `an over-budget index is.`,
    );
  }
  notes.push('Memory files are exempt from the cleanupPeriodDays retention sweep, so they outlive the transcripts they came from.');

  return {
    dir,
    exists: true,
    enabled: on.enabled,
    derivedFrom,
    index,
    indexBudget,
    files,
    counts,
    danglingLinks: [...dangling.values()].sort((a, b) => a.localeCompare(b)),
    orphans: orphans.sort((a, b) => a.localeCompare(b)),
    notes: notes.concat(settingsNotes(unparsable)),
  };
}

function settingsNotes(unparsable: string[]): string[] {
  return unparsable.map(
    (f) => `${f} is not valid JSON, so Claude Code ignores the whole file — any memory settings in it are not in effect.`,
  );
}

/**
 * Auto memory can be switched off two ways, and a panel full of memories that
 * are never loaded is worse than an empty one.
 */
function autoMemoryEnabled(projectPath: string, bad?: string[]): { enabled: boolean; why: string | null } {
  if (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1') {
    return {
      enabled: false,
      why: 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 is set in Wanigan’s environment, which every session it launches inherits. No memory is loaded.',
    };
  }
  const s = settingValue(projectPath, 'autoMemoryEnabled', bad);
  if (s && s.value === false) {
    return { enabled: false, why: `autoMemoryEnabled is false in ${s.layer} settings (${s.file}). No memory is loaded for this project.` };
  }
  return { enabled: true, why: null };
}

/* ── the reading pane ────────────────────────────────────────────────── */

/**
 * Compare real paths, not lexical ones. A symlink sitting inside a memory
 * directory otherwise satisfies a startsWith() check while pointing anywhere.
 */
function realOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * The file itself. The path arrives from the renderer, so it is confined to a
 * memory directory Wanigan has actually resolved: without that, this IPC is a
 * read-any-file-on-disk hole with a friendly name.
 */
export function memoryBody(p: string): { text: string; truncated: boolean; bytes: number } {
  const full = realOrSelf(path.resolve(p));
  const dir = path.dirname(full);
  const inDefaultRoot = full.startsWith(PROJECTS_ROOT + path.sep) && path.basename(dir) === 'memory';

  /*
   * A memory is a markdown file, and requiring that is not cosmetic.
   * `knownDirs` is seeded from memoryDirFor(), which honours an
   * `autoMemoryDirectory` set in a project's own .claude/settings.json — a file
   * that arrives inside whatever repository you cloned. Without this check, a
   * repo shipping { "autoMemoryDirectory": "~/.ssh" } gets that directory
   * marked known, and this IPC hands id_rsa to the renderer. Containment alone
   * is not enough when the thing being contained is attacker-chosen.
   */
  if (!/\.md$/i.test(path.basename(full))) {
    throw new Error(
      `${full} is not a .md file, so it is not a memory. Wanigan only opens markdown from a memory directory.`,
    );
  }
  if (!knownDirs.has(dir) && !inDefaultRoot) {
    throw new Error(
      `${full} is not inside a known memory directory. Open memories from the memory panel, which only offers files ` +
      `from the directory it scanned.`,
    );
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    throw new Error(`Cannot read ${full}. Refresh the memory panel — Claude Code may have rewritten or removed the file.`);
  }
  if (!st.isFile()) throw new Error(`${full} is not a file, so there is no memory to show.`);

  let head: { text: string; complete: boolean };
  try {
    head = readHead(full, BODY_MAX, st.size);
  } catch (e) {
    // statSync can succeed on a file openSync cannot open. Without this the
    // renderer gets a raw `EACCES: permission denied, open …` instead of the
    // sentence-shaped errors every other failure on this path produces.
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Cannot open ${full} (${why}). Check the file's permissions — Wanigan only ever reads memories, never writes them.`,
    );
  }
  return { text: head.text, truncated: !head.complete, bytes: st.size };
}
