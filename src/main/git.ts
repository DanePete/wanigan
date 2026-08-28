import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

/**
 * Git, for the repo you already have open.
 *
 * Wanigan could already read git — diffs, baselines, worktrees — but never act
 * on it, so every commit meant leaving the app. This is the acting half, kept
 * deliberately short of a full client: the operations someone running agents
 * actually performs, and none of the ones where a GUI's guess is worse than a
 * terminal's explicitness.
 *
 * Every call goes through execFile with an argument array, never a shell
 * string. A branch named `; rm -rf ~` is a thing a person can create.
 */

/** Unit separator: it cannot appear in a commit subject, unlike any character. */
const SEP = '\x1f';

export type GitFile = {
  path: string; index: string; work: string;
  staged: boolean; untracked: boolean; conflicted: boolean;
};

export type GitStatus = {
  isRepo: boolean; root: string; branch: string | null; detached: boolean;
  upstream: string | null; ahead: number; behind: number;
  staged: GitFile[]; unstaged: GitFile[]; untracked: GitFile[]; conflicted: GitFile[];
  clean: boolean; operation: string | null;
};

export type Commit = {
  hash: string; short: string; parents: string[];
  author: string; email: string; at: number; subject: string; body: string;
  refs: string[]; head: boolean;
  /** Assigned here so the renderer draws a graph rather than deriving one. */
  lane: number; color: number;
};

export type Branch = {
  name: string; current: boolean; remote: boolean; upstream: string | null;
  ahead: number; behind: number; at: number | null; subject: string | null;
};

export type Stash = { index: number; label: string; at: number | null; subject: string };

async function git(root: string, args: string[], timeout = 30_000) {
  try {
    const { stdout, stderr } = await exec('git', ['-C', root, ...args], {
      timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true as const, out: stdout, err: stderr };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false as const, out: x.stdout ?? '', err: (x.stderr || x.message || 'git failed').trim() };
  }
}

/** git's own message is almost always the most useful thing available. */
function fail(err: string): never {
  throw new Error(err.split('\n').slice(0, 6).join('\n'));
}

/* -- status ---------------------------------------------------------- */

export async function status(dir: string): Promise<GitStatus> {
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    return {
      isRepo: false, root: path.resolve(dir), branch: null, detached: false, upstream: null,
      ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [],
      clean: true, operation: null,
    };
  }
  const root = top.out.trim();
  const r = await git(root, ['status', '--porcelain=v1', '--branch', '-z']);
  if (!r.ok) fail(r.err);

  let branch: string | null = null, upstream: string | null = null;
  let ahead = 0, behind = 0, detached = false;
  const staged: GitFile[] = [], unstaged: GitFile[] = [], untracked: GitFile[] = [], conflicted: GitFile[] = [];

  const parts = r.out.split('\0').filter((x) => x !== '');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.startsWith('##')) {
      const head = line.slice(2).trim();
      if (head.startsWith('HEAD (no branch)')) { detached = true; continue; }
      const [names, track] = head.split(/\s+\[/);
      const [local, up] = names.split('...');
      branch = local || null;
      upstream = up || null;
      if (track) {
        const a = /ahead (\d+)/.exec(track); const b = /behind (\d+)/.exec(track);
        ahead = a ? Number(a[1]) : 0; behind = b ? Number(b[1]) : 0;
      }
      continue;
    }
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    let file = line.slice(3);
    // A rename carries its source path as the next NUL-separated field.
    if (x === 'R' || x === 'C') i++;
    const entry: GitFile = {
      path: file, index: x, work: y,
      staged: x !== ' ' && x !== '?',
      untracked: x === '?',
      conflicted: x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'),
    };
    if (entry.conflicted) conflicted.push(entry);
    else if (entry.untracked) untracked.push(entry);
    else {
      if (x !== ' ') staged.push(entry);
      if (y !== ' ') unstaged.push({ ...entry, staged: false });
    }
  }

  // A merge or rebase in flight changes what every button should say.
  let operation: string | null = null;
  const gd = await git(root, ['rev-parse', '--git-dir']);
  if (gd.ok) {
    const g = path.resolve(root, gd.out.trim());
    if (fs.existsSync(path.join(g, 'MERGE_HEAD'))) operation = 'merge';
    else if (fs.existsSync(path.join(g, 'rebase-merge')) || fs.existsSync(path.join(g, 'rebase-apply'))) operation = 'rebase';
    else if (fs.existsSync(path.join(g, 'CHERRY_PICK_HEAD'))) operation = 'cherry-pick';
    else if (fs.existsSync(path.join(g, 'REVERT_HEAD'))) operation = 'revert';
  }

  return {
    isRepo: true, root, branch, detached, upstream, ahead, behind,
    staged, unstaged, untracked, conflicted,
    clean: !staged.length && !unstaged.length && !untracked.length && !conflicted.length,
    operation,
  };
}

/* -- the graph ------------------------------------------------------- */

/**
 * Lane packing, done here so the renderer draws rather than derives.
 *
 * Walk newest-first holding one slot per open line of history, each waiting
 * for a specific hash. A commit takes the slot waiting for it, or the leftmost
 * free one; its first parent inherits that slot and any other parents open
 * their own. That is the shape every git GUI converges on, and it is stable as
 * long as the walk is.
 */
function assignLanes(commits: Commit[]): void {
  const expected = new Set(commits.map((c) => c.hash));
  const lanes: (string | null)[] = [];
  for (const c of commits) {
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) { lanes.push(null); lane = lanes.length - 1; }
    }
    c.lane = lane;
    c.color = lane % 6;
    lanes[lane] = c.parents[0] && expected.has(c.parents[0]) ? c.parents[0] : null;
    for (const p of c.parents.slice(1)) {
      if (!expected.has(p) || lanes.includes(p)) continue;
      const free = lanes.indexOf(null);
      if (free === -1) lanes.push(p); else lanes[free] = p;
    }
  }
}

export async function log(root: string, opts: { limit?: number; all?: boolean } = {}): Promise<Commit[]> {
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s', '%b'].join(SEP);
  const args = ['log', '--pretty=format:' + fmt + '%x00', '-n' + String(opts.limit ?? 150)];
  if (opts.all) args.push('--all');
  const r = await git(root, args);
  if (!r.ok) return [];

  const head = (await git(root, ['rev-parse', 'HEAD'])).out.trim();
  const commits: Commit[] = [];
  for (const block of r.out.split('\0')) {
    const line = block.replace(/^\n/, '');
    if (!line.trim()) continue;
    const f = line.split(SEP);
    if (f.length < 7) continue;
    commits.push({
      hash: f[0], short: f[0].slice(0, 7),
      parents: f[1].trim() ? f[1].trim().split(' ') : [],
      author: f[2], email: f[3], at: Number(f[4]) * 1000,
      refs: f[5] ? f[5].split(',').map((s) => s.trim()).filter(Boolean) : [],
      subject: f[6], body: (f[7] ?? '').trim(),
      head: f[0] === head, lane: 0, color: 0,
    });
  }
  assignLanes(commits);
  return commits;
}

export async function commitDiff(root: string, hash: string) {
  const stat = await git(root, ['show', '--numstat', '--format=', hash]);
  const files = stat.ok ? stat.out.split('\n').filter(Boolean).map((l) => {
    const [a, d, p] = l.split('\t');
    return { path: p ?? '', added: Number(a) || 0, removed: Number(d) || 0 };
  }).filter((f) => f.path) : [];
  const patch = await git(root, ['show', '--patch', '--format=medium', hash]);
  return { files, patch: patch.ok ? patch.out.slice(0, 400_000) : '' };
}

/* -- branches, stash ------------------------------------------------- */

export async function branches(root: string): Promise<Branch[]> {
  const f = ['%(refname:short)', '%(HEAD)', '%(upstream:short)', '%(upstream:track)',
             '%(committerdate:unix)', '%(contents:subject)'].join(SEP);
  const r = await git(root, ['for-each-ref', '--format=' + f, 'refs/heads', 'refs/remotes']);
  if (!r.ok) return [];
  const out: Branch[] = [];
  for (const line of r.out.split('\n')) {
    if (!line.trim()) continue;
    const [name, head, up, track, date, subject] = line.split(SEP);
    if (name.endsWith('/HEAD')) continue;
    const a = /ahead (\d+)/.exec(track ?? ''); const b = /behind (\d+)/.exec(track ?? '');
    out.push({
      name, current: (head ?? '').trim() === '*', remote: name.startsWith('origin/') || name.includes('/'),
      upstream: up || null, ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0,
      at: date ? Number(date) * 1000 : null, subject: subject || null,
    });
  }
  return out.sort((a, b) => Number(b.current) - Number(a.current) || (b.at ?? 0) - (a.at ?? 0));
}

export async function stashes(root: string): Promise<Stash[]> {
  const r = await git(root, ['stash', 'list', '--format=%gd' + SEP + '%ct' + SEP + '%gs']);
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((l, i) => {
    const [label, at, subject] = l.split(SEP);
    return { index: i, label, at: at ? Number(at) * 1000 : null, subject: subject ?? '' };
  });
}

/* -- acting ---------------------------------------------------------- */

export async function stage(root: string, files: string[]) {
  const r = await git(root, ['add', '--'].concat(files));
  if (!r.ok) fail(r.err);
  return true;
}
export async function unstage(root: string, files: string[]) {
  const r = await git(root, ['restore', '--staged', '--'].concat(files));
  if (!r.ok) fail(r.err);
  return true;
}
/**
 * Discarding tracked changes and deleting untracked files are different acts
 * with different consequences, so they are separate arguments rather than one
 * button that quietly does both.
 */
export async function discard(root: string, tracked: string[], untracked: string[] = []) {
  if (tracked.length) {
    const r = await git(root, ['restore', '--worktree', '--'].concat(tracked));
    if (!r.ok) fail(r.err);
  }
  if (untracked.length) {
    const r = await git(root, ['clean', '-f', '--'].concat(untracked));
    if (!r.ok) fail(r.err);
  }
  return true;
}
export async function commit(root: string, message: string, opts: { amend?: boolean; all?: boolean } = {}) {
  if (!message.trim() && !opts.amend) throw new Error('A commit needs a message.');
  const args = ['commit', '-m', message];
  if (opts.amend) args.push('--amend');
  if (opts.all) args.push('-a');
  const r = await git(root, args);
  if (!r.ok) fail(r.err);
  return r.out.trim();
}
export async function checkout(root: string, ref: string, create = false) {
  const r = await git(root, create ? ['checkout', '-b', ref] : ['checkout', ref]);
  if (!r.ok) fail(r.err);
  return true;
}
export async function deleteBranch(root: string, name: string, force = false) {
  const r = await git(root, ['branch', force ? '-D' : '-d', name]);
  if (!r.ok) fail(r.err);
  return true;
}
export async function merge(root: string, ref: string) {
  const r = await git(root, ['merge', '--no-edit', ref]);
  if (!r.ok) fail(r.err);
  return r.out.trim();
}
export async function fetchAll(root: string) {
  const r = await git(root, ['fetch', '--all', '--prune'], 120_000);
  if (!r.ok) fail(r.err);
  return (r.err || r.out).trim() || 'Up to date.';
}
/** Fast-forward only: a pull that silently merges is a pull that surprises. */
export async function pull(root: string) {
  const r = await git(root, ['pull', '--ff-only'], 120_000);
  if (!r.ok) fail(r.err);
  return r.out.trim() || 'Already up to date.';
}
/** Push leaves the machine, so there is no force flag to reach for by accident. */
export async function push(root: string, opts: { setUpstream?: boolean; branch?: string } = {}) {
  const args = ['push'];
  if (opts.setUpstream && opts.branch) args.push('-u', 'origin', opts.branch);
  const r = await git(root, args, 180_000);
  if (!r.ok) fail(r.err);
  return (r.err || r.out).trim() || 'Pushed.';
}
export async function stashSave(root: string, message: string) {
  const args = ['stash', 'push', '-u'];
  if (message.trim()) args.push('-m', message.trim());
  const r = await git(root, args);
  if (!r.ok) fail(r.err);
  return r.out.trim();
}
export async function stashApply(root: string, index: number, drop: boolean) {
  const r = await git(root, ['stash', drop ? 'pop' : 'apply', 'stash@{' + String(index) + '}']);
  if (!r.ok) fail(r.err);
  return r.out.trim();
}
export async function stashDrop(root: string, index: number) {
  const r = await git(root, ['stash', 'drop', 'stash@{' + String(index) + '}']);
  if (!r.ok) fail(r.err);
  return true;
}
export async function fileDiff(root: string, file: string, staged: boolean) {
  const r = await git(root, staged ? ['diff', '--staged', '--', file] : ['diff', '--', file]);
  return r.ok ? r.out : '';
}
