/**
 * Finding the projects you already work in, from the agent history on disk.
 *
 * Claude Code writes `~/.claude/projects/<slug>/<uuid>.jsonl`; Codex writes
 * `~/.codex/sessions/YYYY/MM/DD/*.jsonl`. Both record the directory the session
 * ran in. Reading those is enough to offer a real list instead of a folder
 * picker, and it needs nothing installed and nothing written.
 *
 * Read-only and best-effort throughout: an unreadable home, a malformed
 * transcript or a directory that has since been deleted is skipped rather than
 * failing the scan. This module never registers a project — `projects:pick`
 * and `projects:add` still own that, so the renderer may propose and main
 * decides, exactly as before.
 *
 * Adapted from T3 Code's AgentSessionScanner (MIT, pingdotgg/t3code). The
 * exclusion list in particular is inherited rather than rediscovered: Codex
 * scratch directories, `~/Downloads`, and linked git worktrees are all
 * directories an agent has genuinely run in and none of them is a project.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRoots } from './accounts';
import { dataDir } from './db';
import { listProjects } from './store';
import { repoSlug } from '../shared/discovery';
import type { DiscoveredProject, DiscoveryResult, DiscoverySource } from '../shared/discovery';

/**
 * Bounds. A machine with years of history must not make this scan unbounded,
 * and the surface says so when one of these stops it rather than presenting a
 * partial list as complete.
 */
const MAX_TRANSCRIPTS = 4_000;
const HEAD_BYTES = 64 * 1024;
const TIME_BUDGET_MS = 6_000;

type Hit = { cwd: string; at: number; source: DiscoverySource };

/** The first `cwd` in a transcript is the directory the session launched in. */
function firstCwd(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(HEAD_BYTES);
    const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    // Line-delimited JSON, and the last line of a bounded read is usually
    // truncated. Parse what is whole and ignore the rest.
    for (const line of text.split('\n')) {
      if (!line.trim() || !line.includes('"cwd"')) continue;
      try {
        const row = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
        const cwd = typeof row.cwd === 'string' ? row.cwd
          : typeof row.payload?.cwd === 'string' ? row.payload.cwd : null;
        if (cwd) return cwd;
      } catch { /* a truncated or malformed record is not a failed scan */ }
    }
  } catch { /* unreadable transcript */ } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
  return null;
}

function walkTranscripts(root: string, depth: number, out: string[], limit: number): void {
  if (out.length >= limit || depth < 0) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = path.join(root, entry.name);
    // Never follow a symlink out of the history tree: a link placed in there
    // would otherwise make this walk somebody else's filesystem.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkTranscripts(full, depth - 1, out, limit);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

/**
 * Directories an agent has run in that are nevertheless never projects.
 *
 * Codex creates one scratch directory per conversation under
 * `~/Documents/Codex`; nothing unpacked into `~/Downloads` is a project; and a
 * session started in `/tmp` reports `/private/tmp` on macOS. Wanigan's own
 * worktrees are excluded for the reason its worktree code already states —
 * they live outside the repo precisely so nothing treats them as one.
 */
export function excluded(candidate: string, home: string, worktreeRoots: readonly string[]): boolean {
  const resolved = path.resolve(candidate);
  if (path.resolve(home) === resolved) return true;

  // Temp is an ancestor test, not an equality test, and it needs both spellings.
  // On macOS os.tmpdir() answers `/var/folders/…/T` while the realpath every
  // scanned transcript actually records is `/private/var/folders/…/T`. A
  // runtime probe found 311 conversations in one such directory being offered
  // as a project: the app's own test runs, which are the single busiest "repo"
  // on this machine and never a repo at all.
  const temps = new Set<string>(['/tmp', '/private/tmp']);
  for (const dir of [os.tmpdir()]) {
    try { temps.add(path.resolve(dir)); } catch { /* unusable tmpdir */ }
    try { temps.add(fs.realpathSync(dir)); } catch { /* not resolvable */ }
  }

  const ancestors = [
    ...temps,
    path.join(home, 'Downloads'),
    path.join(home, 'Documents', 'Codex'),
    ...worktreeRoots,
  ];
  return ancestors.some((ancestor) => resolved === ancestor || resolved.startsWith(ancestor + path.sep));
}

/**
 * Git identity read straight off `.git`, without spawning git.
 *
 * A scan can face hundreds of candidates and a process per candidate is the
 * difference between instant and unusable. A `.git` file rather than a
 * directory is a `gitdir:` pointer; when it points inside `worktrees/` the
 * checkout is a linked worktree, whose history belongs to the main checkout,
 * so it is not offered separately.
 */
function gitIdentity(dir: string): { remote: string | null } | null | 'worktree' {
  const dotGit = path.join(dir, '.git');
  let stat: fs.Stats;
  try { stat = fs.statSync(dotGit); } catch { return null; }

  let gitDir = dotGit;
  if (stat.isFile()) {
    try {
      const pointer = fs.readFileSync(dotGit, 'utf8').trim();
      const target = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
      if (!target) return null;
      gitDir = path.resolve(dir, target);
    } catch { return null; }
    if (/[\\/]worktrees[\\/]/.test(gitDir)) return 'worktree';
  } else if (!stat.isDirectory()) {
    return null;
  }

  try {
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const url = /\[remote "origin"\][^[]*?\burl\s*=\s*(.+)/s.exec(config)?.[1]?.split('\n')[0]?.trim();
    return { remote: url || null };
  } catch {
    // A repository with no config still is one.
    return { remote: null };
  }
}

/**
 * Where Wanigan keeps its own worktrees, so the scan never offers one back as a
 * project. worktrees.ts builds them under `dataDir()/worktrees`, and an agent
 * that ran in one recorded that path in its transcript like any other — which
 * is exactly how a disposable sandbox would otherwise arrive here looking like
 * a repository worth importing.
 */
function worktreeRoots(): string[] {
  try { return [path.resolve(path.join(dataDir(), 'worktrees'))]; }
  catch { return []; }
}

/**
 * The candidate set from the most recent scan this process performed.
 *
 * This is what keeps import inside the trust boundary. projects:add refuses a
 * path the interface names, because the renderer must not be able to widen the
 * set of directories Wanigan will act on. An import is allowed to name a path
 * only because *main* discovered it: the renderer chooses from a set main
 * produced, main re-checks membership, and a person still confirms in a
 * main-process dialog. A path that never came out of a scan is refused exactly
 * as projects:add refuses one today.
 */
let lastCandidates = new Set<string>();

/** Whether main itself discovered this path in its most recent scan. */
export function wasDiscovered(candidate: string): boolean {
  return lastCandidates.has(path.resolve(candidate));
}

export function discoverProjects(): DiscoveryResult {
  const started = Date.now();
  const home = os.homedir();
  const files: string[] = [];

  // Claude keeps one directory per working directory; Codex nests by date.
  for (const root of readRoots('claude-code')) walkTranscripts(path.join(root, 'projects'), 3, files, MAX_TRANSCRIPTS);
  for (const root of readRoots('codex')) walkTranscripts(path.join(root, 'sessions'), 5, files, MAX_TRANSCRIPTS);

  const truncatedByCount = files.length >= MAX_TRANSCRIPTS;
  const hits: Hit[] = [];
  let scanned = 0;
  let timedOut = false;

  for (const file of files) {
    if (Date.now() - started > TIME_BUDGET_MS) { timedOut = true; break; }
    scanned += 1;
    const cwd = firstCwd(file);
    if (!cwd) continue;
    let at = 0;
    try { at = fs.statSync(file).mtimeMs; } catch { /* keep 0 */ }
    hits.push({ cwd, at, source: file.includes(`${path.sep}sessions${path.sep}`) ? 'codex' : 'claude' });
  }

  const known = new Set<string>();
  for (const project of listProjects()) {
    try { known.add(fs.realpathSync(project.path)); } catch { known.add(path.resolve(project.path)); }
  }

  const roots = worktreeRoots();
  const byPath = new Map<string, DiscoveredProject>();
  for (const hit of hits) {
    let resolved: string;
    try { resolved = fs.realpathSync(hit.cwd); } catch { continue; }
    if (excluded(resolved, home, roots)) continue;

    const existing = byPath.get(resolved);
    if (existing) {
      byPath.set(resolved, {
        ...existing,
        conversations: existing.conversations + 1,
        lastActiveAt: Math.max(existing.lastActiveAt, hit.at),
        sources: existing.sources.includes(hit.source) ? existing.sources : [...existing.sources, hit.source],
      });
      continue;
    }

    const git = gitIdentity(resolved);
    if (git === 'worktree') continue;
    const remote = git?.remote ?? null;
    byPath.set(resolved, {
      path: resolved,
      name: repoSlug(remote) ?? path.basename(resolved),
      remote,
      conversations: 1,
      lastActiveAt: hit.at,
      known: known.has(resolved),
      sources: [hit.source],
    });
  }

  const projects = [...byPath.values()];
  lastCandidates = new Set(projects.map((project) => project.path));
  return { projects, scanned, truncated: truncatedByCount || timedOut };
}
