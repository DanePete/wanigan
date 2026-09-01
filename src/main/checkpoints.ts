import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { db } from './db';
import { runGit } from './git';
import { onHookEvent } from './hooks';
import { assertManagedRoot } from './roots';
import { getSetting } from './settings';
import type {
  CheckpointDiff, CheckpointKind, CheckpointRevertAction, CheckpointRevertPlan,
  CheckpointRevertResult, SessionCheckpoint,
} from '../shared/types';

/**
 * Per-turn workspace checkpoints.
 *
 * The session baseline answers "what did this whole session do"; these answer
 * "what did turn 3 do" and "put the tree back to just before my last prompt".
 * Each capture is a real git commit built through a scratch index, reachable
 * only from refs/wanigan/checkpoints/<session> — HEAD, the user's index, their
 * branches and their working tree are never written by a capture. Because the
 * snapshot is git, it sees the three things Claude's own /rewind documents it
 * cannot restore: files changed by a bash command, edits made by a subagent,
 * and anything reached through a symlink.
 *
 * Boundaries come from the hook bus, so the feature is gated on the harness
 * actually proving hook support at launch. A provider without verified hooks
 * gets an honest absence, not a simulation.
 */

/** A capture that cannot finish inside this is a capture the repo cannot afford. */
const CAPTURE_TIMEOUT_MS = 30_000;
/** Consecutive failures before capture stops for the session, visibly. */
const MAX_CONSECUTIVE_FAILURES = 2;
/** The patch a diff returns is for reading, not archiving. Same cap as the code panel. */
const MAX_PATCH_LINES = 4_000;
/** Name-status rows returned per diff or revert plan; the count still reports the rest. */
const MAX_PLAN_FILES = 500;
/** Pathspecs per git restore invocation, to stay clear of argv limits. */
const RESTORE_CHUNK = 150;
/** Sessions swept per retention pass; the next pass takes the next slice. */
const PRUNE_SESSIONS_PER_PASS = 50;

/** Checkpoint commits carry a fixed identity so nothing leaks user git config. */
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: 'Wanigan',
  GIT_AUTHOR_EMAIL: 'wanigan@localhost',
  GIT_COMMITTER_NAME: 'Wanigan',
  GIT_COMMITTER_EMAIL: 'wanigan@localhost',
};

type LiveState = {
  /** Repo top-level the session captures into ('' until resolved). */
  root: string;
  turn: number;
  /** Serial per-session queue; captures never overlap or reorder. */
  chain: Promise<unknown>;
  lastTree: string | null;
  lastCommit: string | null;
  consecutiveFailures: number;
  disabled: boolean;
};

const live = new Map<string, LiveState>();
let subscribed = false;

export type CheckpointLaunchInfo = {
  sessionId: string;
  /** Where the agent runs — the worktree when isolated, the project otherwise. */
  cwd: string;
  /** True only when the harness proved hook support and hooks were injected. */
  hooksCapable: boolean;
  /** The baseline head; null means the directory is not a usable git repo. */
  gitHead: string | null;
};

/* ── wiring ──────────────────────────────────────────────────────────── */

/** Subscribes to the hook bus. Call once from main startup. */
export function initCheckpoints(): void {
  if (subscribed) return;
  subscribed = true;
  onHookEvent((e) => {
    if (e.event === 'UserPromptSubmit') enqueueBoundary(e.sessionId, 'turn-start');
    else if (e.event === 'Stop') enqueueBoundary(e.sessionId, 'turn-end');
  });
}

/**
 * Starts capture for one launched session. The launch snapshot is taken here,
 * before the agent's first action, which is what finally makes pre-session
 * dirty work restorable — the baseline records that it existed, this records
 * what it said.
 */
export function registerSessionCheckpoints(info: CheckpointLaunchInfo): void {
  if (!checkpointsEnabled()) return;
  if (!info.hooksCapable || !info.gitHead) return;
  if (live.has(info.sessionId)) return;
  const state: LiveState = {
    root: '', turn: 0, chain: Promise.resolve(),
    lastTree: null, lastCommit: null, consecutiveFailures: 0, disabled: false,
  };
  live.set(info.sessionId, state);
  state.chain = (async () => {
    const top = await runGit(info.cwd, ['rev-parse', '--show-toplevel'], { timeout: 8_000 });
    const root = top.out.trim();
    if (!top.ok || !root) {
      state.disabled = true;
      record(info.sessionId, 0, 'session-start', info.cwd, null, null, null, 'failed',
        `This directory is not a git work tree, so no checkpoints will be captured: ${clip(top.err, 200)}`);
      return;
    }
    state.root = root;
    // A fresh id starts at 0; MAX(turn) only matters if a crash re-registers.
    const row = db().prepare('SELECT MAX(turn) AS t FROM session_checkpoints WHERE session_id = ?')
      .get(info.sessionId) as { t: number | null } | undefined;
    if (row?.t != null) state.turn = row.t;
    await capture(info.sessionId, state, 'session-start', 0);
  })().catch(() => { /* recorded by capture; a failed launch snapshot must not throw */ });
}

/**
 * Final snapshot and teardown at PTY exit. Awaited by the exit handler before
 * it considers removing a clean worktree, so the last state is never lost to
 * that race. Rows and the ref stay — they are the history.
 */
export function finalizeSessionCheckpoints(sessionId: string): Promise<void> {
  const state = live.get(sessionId);
  if (!state) return Promise.resolve();
  const done = enqueueCapture(sessionId, state, 'session-end', state.turn);
  return done.then(() => {}, () => {}).finally(() => {
    live.delete(sessionId);
    try { fs.rmSync(indexFileFor(sessionId), { force: true }); } catch { /* scratch file */ }
  });
}

function enqueueBoundary(sessionId: string, kind: CheckpointKind): void {
  const state = live.get(sessionId);
  if (!state || state.disabled) return;
  const turn = kind === 'turn-start' ? ++state.turn : state.turn;
  void enqueueCapture(sessionId, state, kind, turn);
}

function enqueueCapture(sessionId: string, state: LiveState, kind: CheckpointKind, turn: number): Promise<number | null> {
  const job = state.chain.then(
    () => capture(sessionId, state, kind, turn),
    () => capture(sessionId, state, kind, turn),
  );
  state.chain = job.then(() => {}, () => {});
  return job;
}

/* ── capture ─────────────────────────────────────────────────────────── */

async function capture(sessionId: string, state: LiveState, kind: CheckpointKind, turn: number): Promise<number | null> {
  if (state.disabled || !state.root) return null;
  const at = Date.now();
  try { assertManagedRoot(state.root, 'This repository'); } catch (e) {
    state.disabled = true;
    return record(sessionId, turn, kind, state.root, null, null, null, 'failed', message(e), at);
  }
  const env = { GIT_INDEX_FILE: indexFileFor(sessionId) };
  const opts = { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env };

  const add = await runGit(state.root, ['add', '-A', '.'], opts);
  if (!add.ok) return failed(sessionId, state, turn, kind, at, `git add: ${clip(add.err, 300)}`);

  const wt = await runGit(state.root, ['write-tree'], opts);
  const tree = wt.out.trim();
  if (!wt.ok || !tree) return failed(sessionId, state, turn, kind, at, `git write-tree: ${clip(wt.err, 300)}`);

  if (tree === state.lastTree && state.lastCommit) {
    state.consecutiveFailures = 0;
    return record(sessionId, turn, kind, state.root, state.lastCommit, tree, 0, 'skipped-unchanged', null, at);
  }

  const parent = state.lastCommit;
  const ct = await runGit(state.root,
    ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `wanigan ${kind} · turn ${turn} · session ${sessionId}`],
    { ...opts, env: { ...env, ...AUTHOR_ENV } });
  const commit = ct.out.trim();
  if (!ct.ok || !commit) return failed(sessionId, state, turn, kind, at, `git commit-tree: ${clip(ct.err, 300)}`);

  // Without the ref the commit is garbage-collection bait; an unreferenced
  // checkpoint is a checkpoint that quietly stops existing, so this failing
  // fails the capture.
  const ur = await runGit(state.root, ['update-ref', refFor(sessionId), commit], opts);
  if (!ur.ok) return failed(sessionId, state, turn, kind, at, `git update-ref: ${clip(ur.err, 300)}`);

  let filesChanged: number | null = null;
  if (parent) {
    const dt = await runGit(state.root, ['diff-tree', '-r', '--name-only', '--no-renames', parent, commit], opts);
    if (dt.ok) filesChanged = dt.out.split('\n').filter(Boolean).length;
  }

  state.lastTree = tree;
  state.lastCommit = commit;
  state.consecutiveFailures = 0;
  return record(sessionId, turn, kind, state.root, commit, tree, filesChanged, 'ok', null, at);
}

function failed(sessionId: string, state: LiveState, turn: number, kind: CheckpointKind, at: number, detail: string): number | null {
  state.consecutiveFailures += 1;
  const disabling = state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  if (disabling) state.disabled = true;
  return record(sessionId, turn, kind, state.root, null, null, null, 'failed',
    disabling ? `${detail} — capture is off for the rest of this session.` : detail, at);
}

function record(
  sessionId: string, turn: number, kind: string, repoRoot: string,
  commit: string | null, tree: string | null, filesChanged: number | null,
  status: 'ok' | 'failed' | 'skipped-unchanged', detail: string | null, at = Date.now(),
): number | null {
  try {
    const res = db().prepare(`
      INSERT INTO session_checkpoints (session_id, turn, kind, at, repo_root, commit_hash, tree_hash, files_changed, status, detail)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(sessionId, turn, kind, at, repoRoot, commit, tree, filesChanged, status, detail);
    return Number(res.lastInsertRowid);
  } catch {
    // Losing one row must never take a session down with it.
    return null;
  }
}

/* ── reading ─────────────────────────────────────────────────────────── */

export function listCheckpoints(sessionId: string): SessionCheckpoint[] {
  const rows = db().prepare(`
    SELECT id, session_id, turn, kind, at, repo_root, commit_hash, tree_hash, files_changed, status, detail
      FROM session_checkpoints WHERE session_id = ?
     ORDER BY turn, at, id LIMIT 1000
  `).all(sessionId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    sessionId: String(r.session_id),
    turn: Number(r.turn),
    kind: String(r.kind),
    at: Number(r.at),
    repoRoot: String(r.repo_root),
    commitHash: r.commit_hash == null ? null : String(r.commit_hash),
    treeHash: r.tree_hash == null ? null : String(r.tree_hash),
    filesChanged: r.files_changed == null ? null : Number(r.files_changed),
    status: (r.status === 'failed' || r.status === 'skipped-unchanged' ? r.status : 'ok'),
    detail: r.detail == null ? null : String(r.detail),
  }));
}

function checkpointRow(sessionId: string, checkpointId: number): SessionCheckpoint | null {
  const all = listCheckpoints(sessionId);
  return all.find((c) => c.id === checkpointId) ?? null;
}

/**
 * Where reads run. The capture root is right while it exists; after an
 * isolated worktree is gone, the ref and objects still live in the shared
 * repository, so the project checkout can answer diffs.
 */
async function readRoot(sessionId: string, repoRoot: string): Promise<string | null> {
  if (fs.existsSync(repoRoot)) return repoRoot;
  let projectPath: string | null = null;
  try {
    const row = db().prepare('SELECT project_path FROM session_log WHERE id = ?').get(sessionId) as { project_path?: string } | undefined;
    projectPath = row?.project_path ?? null;
  } catch { return null; }
  if (!projectPath || !fs.existsSync(projectPath)) return null;
  const top = await runGit(projectPath, ['rev-parse', '--show-toplevel'], { timeout: 8_000 });
  const root = top.out.trim();
  return top.ok && root ? root : null;
}

export async function checkpointDiff(sessionId: string, fromId: number, toId: number): Promise<CheckpointDiff> {
  const from = checkpointRow(sessionId, fromId);
  const to = checkpointRow(sessionId, toId);
  if (!from?.commitHash || !to?.commitHash) {
    throw new Error('One of those checkpoints has no commit — its capture failed, so there is nothing to compare.');
  }
  const root = await readRoot(sessionId, from.repoRoot);
  if (!root) throw new Error('Neither the captured checkout nor the project directory exists any more, so the diff cannot be read.');
  assertManagedRoot(root, 'This repository');

  const ns = await runGit(root, ['diff-tree', '-r', '--name-status', '--no-renames', from.commitHash, to.commitHash],
    { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  if (!ns.ok) throw new Error(`git could not compare the two checkpoints: ${clip(ns.err, 300)}`);
  const allFiles = ns.out.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    return { path: rest.join('\t'), status: status ?? '?' };
  });

  const patchRun = await runGit(root, ['diff', from.commitHash, to.commitHash],
    { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  const lines = patchRun.ok ? patchRun.out.split('\n') : [];
  const truncated = lines.length > MAX_PATCH_LINES;

  return {
    from: from.commitHash,
    to: to.commitHash,
    files: allFiles.slice(0, MAX_PLAN_FILES),
    totalFiles: allFiles.length,
    patch: truncated ? lines.slice(0, MAX_PATCH_LINES).join('\n') : patchRun.out,
    truncated,
  };
}

/* ── revert ──────────────────────────────────────────────────────────── */

/**
 * A snapshot of right now, whether or not the session still runs. The live
 * queue is reused when there is one so a revert cannot interleave with a
 * boundary capture; a finished session gets an ephemeral chain seeded from
 * its last recorded checkpoint.
 */
async function captureNow(sessionId: string, root: string, kind: CheckpointKind): Promise<number | null> {
  const state = live.get(sessionId);
  if (state) return enqueueCapture(sessionId, state, kind, state.turn);
  const rows = listCheckpoints(sessionId);
  const lastOk = [...rows].reverse().find((c) => c.commitHash);
  const ephemeral: LiveState = {
    root,
    turn: rows.reduce((m, c) => Math.max(m, c.turn), 0),
    chain: Promise.resolve(),
    lastTree: lastOk?.treeHash ?? null,
    lastCommit: lastOk?.commitHash ?? null,
    consecutiveFailures: 0,
    disabled: false,
  };
  return capture(sessionId, ephemeral, kind, ephemeral.turn);
}

async function revertActions(root: string, targetCommit: string, currentCommit: string): Promise<CheckpointRevertAction[]> {
  const dt = await runGit(root, ['diff-tree', '-r', '--name-status', '--no-renames', targetCommit, currentCommit],
    { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  if (!dt.ok) throw new Error(`git could not compare the checkpoint with the current state: ${clip(dt.err, 300)}`);
  const actions: CheckpointRevertAction[] = [];
  for (const line of dt.out.split('\n')) {
    if (!line) continue;
    const [status, ...rest] = line.split('\t');
    const p = rest.join('\t');
    if (!p) continue;
    // Statuses read target→current: added since the checkpoint means delete
    // now; deleted or modified since means restore from the checkpoint.
    if (status === 'A') actions.push({ path: p, action: 'delete' });
    else actions.push({ path: p, action: 'restore' });
  }
  return actions;
}

function revertPreconditions(sessionId: string, checkpointId: number):
  { row: SessionCheckpoint; root: string; commit: string } | { refusal: string } {
  const row = checkpointRow(sessionId, checkpointId);
  if (!row) return { refusal: 'That checkpoint does not exist for this session.' };
  if (!row.commitHash) return { refusal: 'That checkpoint has no commit — its capture failed, so there is no state to restore.' };
  if (!fs.existsSync(row.repoRoot)) {
    return { refusal: 'The checkout this checkpoint was captured in no longer exists. Wanigan will not restore it into a different directory. Nothing was changed.' };
  }
  try { assertManagedRoot(row.repoRoot, 'That repository'); } catch (e) { return { refusal: message(e) }; }
  return { row, root: row.repoRoot, commit: row.commitHash };
}

export async function checkpointRevertPlan(sessionId: string, checkpointId: number): Promise<CheckpointRevertPlan> {
  const pre = revertPreconditions(sessionId, checkpointId);
  if ('refusal' in pre) return { ok: false, checkpointId, commit: null, files: [], totalFiles: 0, detail: pre.refusal };
  const { row, root, commit } = pre;

  // The plan compares against a snapshot of now, not `git status`: only a tree
  // sees the untracked files a revert would have to delete.
  const nowId = await captureNow(sessionId, root, 'pre-revert');
  const nowRow = nowId == null ? null : checkpointRow(sessionId, nowId);
  if (!nowRow?.commitHash) {
    return { ok: false, checkpointId, commit, files: [], totalFiles: 0,
      detail: 'Wanigan could not snapshot the current state, so it cannot say exactly what a revert would do. Nothing was changed.' };
  }

  const actions = await revertActions(root, commit, nowRow.commitHash);
  const restores = actions.filter((a) => a.action === 'restore').length;
  const deletes = actions.length - restores;
  return {
    ok: true,
    checkpointId,
    commit,
    files: actions.slice(0, MAX_PLAN_FILES),
    totalFiles: actions.length,
    detail: actions.length === 0
      ? 'The working tree already matches this checkpoint. Nothing to do.'
      : `Restores ${restores} file${restores === 1 ? '' : 's'} to turn ${row.turn}'s state and deletes ${deletes} created since. A safety snapshot is taken first, so this is undoable.`,
  };
}

export async function applyCheckpointRevert(sessionId: string, checkpointId: number): Promise<CheckpointRevertResult> {
  const pre = revertPreconditions(sessionId, checkpointId);
  if ('refusal' in pre) return { ok: false, reverted: 0, deleted: 0, failed: [], preRevertCheckpointId: null, detail: pre.refusal };
  const { row, root, commit } = pre;

  const preId = await captureNow(sessionId, root, 'pre-revert');
  const preRow = preId == null ? null : checkpointRow(sessionId, preId);
  if (!preRow?.commitHash) {
    return { ok: false, reverted: 0, deleted: 0, failed: [], preRevertCheckpointId: null,
      detail: 'The safety snapshot failed, so the revert did not start. Nothing was changed.' };
  }

  const actions = await revertActions(root, commit, preRow.commitHash);
  const toRestore = actions.filter((a) => a.action === 'restore').map((a) => a.path);
  const toDelete = actions.filter((a) => a.action === 'delete').map((a) => a.path);
  const failures: { path: string; detail: string }[] = [];

  let restored = 0;
  for (let i = 0; i < toRestore.length; i += RESTORE_CHUNK) {
    const chunk = toRestore.slice(i, i + RESTORE_CHUNK);
    const res = await runGit(root, ['restore', '--source', commit, '--worktree', '--', ...chunk],
      { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    if (res.ok) { restored += chunk.length; continue; }
    // Retry singly so one bad path costs itself, not its whole chunk.
    for (const p of chunk) {
      const one = await runGit(root, ['restore', '--source', commit, '--worktree', '--', p],
        { timeout: CAPTURE_TIMEOUT_MS });
      if (one.ok) restored += 1;
      else failures.push({ path: p, detail: clip(one.err, 200) || 'git restore failed' });
    }
  }

  let deleted = 0;
  for (const p of toDelete) {
    const abs = containedPath(root, p);
    if (!abs) { failures.push({ path: p, detail: 'resolves outside the repository, so it was not touched' }); continue; }
    try {
      const st = fs.lstatSync(abs, { throwIfNoEntry: false });
      if (!st) { deleted += 1; continue; }
      if (st.isDirectory()) { failures.push({ path: p, detail: 'is a directory now; expected a file' }); continue; }
      fs.rmSync(abs);
      deleted += 1;
    } catch (e) {
      failures.push({ path: p, detail: clip(message(e), 200) });
    }
  }

  const ok = failures.length === 0;
  return {
    ok,
    reverted: restored,
    deleted,
    failed: failures,
    preRevertCheckpointId: preId,
    detail: actions.length === 0
      ? 'The working tree already matched this checkpoint. Nothing was changed.'
      : `Restored ${restored} and deleted ${deleted} file${deleted === 1 ? '' : 's'} to reach turn ${row.turn}'s state.${ok ? '' : ` ${failures.length} could not be changed.`}`,
  };
}

/* ── cleanup ─────────────────────────────────────────────────────────── */

/** Rows and ref for one session, when it is deleted from history. */
export function forgetSessionCheckpoints(sessionId: string): void {
  let roots: string[] = [];
  try {
    roots = (db().prepare('SELECT DISTINCT repo_root FROM session_checkpoints WHERE session_id = ?')
      .all(sessionId) as Array<{ repo_root: string }>).map((r) => r.repo_root);
  } catch { /* rows unreadable; still try the delete below */ }
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    void runGit(root, ['update-ref', '-d', refFor(sessionId)], { timeout: 8_000 }).catch(() => {});
  }
  try { db().prepare('DELETE FROM session_checkpoints WHERE session_id = ?').run(sessionId); } catch { /* next prune retries */ }
  live.delete(sessionId);
  try { fs.rmSync(indexFileFor(sessionId), { force: true }); } catch { /* scratch file */ }
}

/** Retention, driven by the queue tick alongside hook-event pruning. */
export function pruneCheckpoints(olderThanMs: number): number {
  const cutoff = Date.now() - Math.max(0, olderThanMs);
  let sessions: string[] = [];
  try {
    sessions = (db().prepare(`
      SELECT session_id FROM session_checkpoints
       GROUP BY session_id HAVING MAX(at) < ? LIMIT ${PRUNE_SESSIONS_PER_PASS}
    `).all(cutoff) as Array<{ session_id: string }>).map((r) => r.session_id);
  } catch { return 0; }
  let gone = 0;
  for (const id of sessions) {
    if (live.has(id)) continue;
    forgetSessionCheckpoints(id);
    gone += 1;
  }
  return gone;
}

/**
 * Every Wanigan ref in one repository, for the Settings cleanup button.
 * Counts first, deletes only when told to — five hundred refs is a different
 * act from three.
 */
export async function removeRepoCheckpoints(projectPath: string, apply: boolean): Promise<{ refs: number; rows: number; applied: boolean }> {
  const top = await runGit(projectPath, ['rev-parse', '--show-toplevel'], { timeout: 8_000 });
  const root = top.out.trim();
  if (!top.ok || !root) throw new Error('That folder is not a git repository, so there are no checkpoints to remove.');
  assertManagedRoot(root, 'That repository');

  const fer = await runGit(root, ['for-each-ref', '--format=%(refname)', 'refs/wanigan/'], { timeout: 15_000 });
  const refs = fer.ok ? fer.out.split('\n').filter(Boolean) : [];
  const suffixes = new Set(refs.map((r) => r.split('/').pop() ?? ''));

  // The ref name is a sanitised session id, so map rows through the same
  // sanitiser rather than trusting repo_root, which a removed worktree broke.
  let sessionIds: string[] = [];
  try {
    const all = db().prepare('SELECT DISTINCT session_id, repo_root FROM session_checkpoints').all() as Array<{ session_id: string; repo_root: string }>;
    sessionIds = all
      .filter((r) => suffixes.has(safeRefName(r.session_id)) || r.repo_root === root || r.repo_root.startsWith(root + path.sep))
      .map((r) => r.session_id);
  } catch { /* rows unreadable; refs can still be removed */ }
  const uniqueIds = [...new Set(sessionIds)].filter((id) => !live.has(id));

  if (!apply) return { refs: refs.length, rows: uniqueIds.length, applied: false };

  for (const ref of refs) {
    await runGit(root, ['update-ref', '-d', ref], { timeout: 8_000 });
  }
  for (const id of uniqueIds) {
    try { db().prepare('DELETE FROM session_checkpoints WHERE session_id = ?').run(id); } catch { /* next prune retries */ }
  }
  return { refs: refs.length, rows: uniqueIds.length, applied: true };
}

/* ── small parts ─────────────────────────────────────────────────────── */

function checkpointsEnabled(): boolean {
  try {
    const v = getSetting('checkpoints', '1');
    return v !== '0' && v !== 'false';
  } catch {
    return true;
  }
}

/** Ref components stay [A-Za-z0-9_-]: no '..', no '.lock', no path tricks. */
function safeRefName(sessionId: string): string {
  const clean = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
  return clean || 'session';
}

function refFor(sessionId: string): string {
  return `refs/wanigan/checkpoints/${safeRefName(sessionId)}`;
}

function indexFileFor(sessionId: string): string {
  const dir = path.join(app.getPath('userData'), 'checkpoints');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${safeRefName(sessionId)}.index`);
}

/** Symlink-safe containment, same contract as revert.ts. */
function containedPath(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  const realRoot = (() => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } })();
  const parent = (() => { try { return fs.realpathSync(path.dirname(abs)); } catch { return path.dirname(abs); } })();
  const real = path.join(parent, path.basename(abs));
  return real === realRoot || real.startsWith(realRoot + path.sep) ? real : null;
}

function clip(s: string, n: number): string {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Direct capture access for the offline smoke suite — no hook bus, no PTY. */
export const __test = {
  registerSessionCheckpoints,
  enqueueBoundary,
  finalizeSessionCheckpoints,
  awaitIdle: async (sessionId: string) => { const s = live.get(sessionId); if (s) await s.chain; },
  isLive: (sessionId: string) => live.has(sessionId),
};
