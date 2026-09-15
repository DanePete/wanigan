import fs from 'node:fs';
import { db } from './db';
import { runGit } from './git';
import { registeredHookCwd } from './hooks';
import { contextForSession, recordEvidenceRow, trustFor } from './policy';
import { redactCredentials } from './redact';
import { isManagedRoot } from './roots';
import { classifyMoves, parseRefSnapshot, refMoves, rewriteCommandsIn, type RefSnapshot } from '../shared/git-rewrite';
import type { HookInput, SessionEvent } from '../shared/types';

/**
 * Evidence that survives a history rewrite.
 *
 * At the first event of a session this snapshots the repository's branches,
 * tags, remote-tracking refs and a detached HEAD. At every Stop — the end of a
 * turn — it snapshots again and asks git whether each moved ref still contains
 * where it was. A deleted ref, or one moved somewhere that does not contain its
 * old commit, has orphaned that commit, and `git gc` would eventually collect
 * it. So the old commit is pinned under refs/wanigan/evidence/<session>/<n>, a
 * Wanigan-private namespace like refs/wanigan/checkpoints/, and a ledger row
 * and a policy signal say what moved.
 *
 * It only ever runs `for-each-ref`, `rev-parse`, `merge-base --is-ancestor`,
 * `cat-file -e` and `update-ref` on its own namespace: nothing here writes the
 * working tree, the index, HEAD or any ref outside refs/wanigan/. The pins are
 * pruned by the checkpoint retention in checkpoints.ts.
 *
 * Not blocked, only recorded. A rewrite is often exactly what the operator
 * asked for; the point is that it cannot also erase the record of itself.
 */

type State = { root: string; snapshot: RefSnapshot; chain: Promise<unknown> };
const states = new Map<string, State>();
const MAX_STATES = 200;
const GIT = { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 };

export function evidenceRefPrefix(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96) || 'session';
  return `refs/wanigan/evidence/${safe}/`;
}

async function snapshot(root: string): Promise<RefSnapshot | null> {
  const refs = await runGit(root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags', 'refs/remotes'], GIT);
  if (!refs.ok) return null;
  const symbolic = await runGit(root, ['symbolic-ref', '-q', 'HEAD'], GIT);
  let detached: string | null = null;
  if (!symbolic.ok) {
    const head = await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD'], GIT);
    detached = head.ok ? head.out.trim() : null;
  }
  return parseRefSnapshot(refs.out, detached);
}

async function rootFor(sessionId: string, cwd: string | null): Promise<string | null> {
  const dir = cwd ?? registeredHookCwd(sessionId);
  if (!dir || !fs.existsSync(dir)) return null;
  const top = await runGit(dir, ['rev-parse', '--show-toplevel'], { timeout: 8_000 });
  const root = top.out.trim();
  return top.ok && root && isManagedRoot(root) ? root : null;
}

function projectOf(sessionId: string): { projectId: string | null } {
  const ctx = contextForSession(sessionId);
  if (ctx) return { projectId: ctx.projectId };
  try {
    const row = db().prepare('SELECT project_id FROM session_log WHERE id = ?').get(sessionId) as { project_id: string | null } | undefined;
    return { projectId: row?.project_id ?? null };
  } catch { return { projectId: null }; }
}

function signal(sessionId: string, projectId: string | null, kind: string, rule: string, summary: string, detail: unknown): void {
  try {
    db().prepare('INSERT INTO policy_signals (at, session_id, project_id, kind, rule, summary, detail_json) VALUES (?,?,?,?,?,?,?)')
      .run(Date.now(), sessionId, projectId, kind, rule, redactCredentials(summary).slice(0, 400), JSON.stringify(detail));
  } catch { /* the pin, if made, still stands */ }
}

async function compareAndPin(sessionId: string, state: State): Promise<void> {
  const next = await snapshot(state.root);
  if (!next) return;
  const moves = refMoves(state.snapshot, next);
  state.snapshot = next;
  if (!moves.length) return;
  const answers = new Map<string, boolean | null>();
  for (const m of moves) {
    if (!m.to) continue;
    const r = await runGit(state.root, ['merge-base', '--is-ancestor', m.from, m.to], GIT);
    answers.set(`${m.from}..${m.to}`, r.ok ? true : r.code === 1 ? false : null);
  }
  const rewrites = classifyMoves(moves, (from, to) => answers.get(`${from}..${to}`) ?? null);
  if (!rewrites.length) return;

  const prefix = evidenceRefPrefix(sessionId);
  const existing = await runGit(state.root, ['for-each-ref', '--format=%(refname)', prefix], GIT);
  let n = existing.ok ? existing.out.split('\n').filter(Boolean).length : 0;
  const pinned = new Map<string, string>();
  const { projectId } = projectOf(sessionId);
  const trust = contextForSession(sessionId)?.trust ?? trustFor(projectId);

  for (const rw of rewrites) {
    let pin = pinned.get(rw.from) ?? null;
    if (!pin && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(rw.from)) {
      const exists = await runGit(state.root, ['cat-file', '-e', rw.from], GIT);
      if (exists.ok) {
        n += 1;
        const ref = `${prefix}${n}`;
        const made = await runGit(state.root, ['update-ref', ref, rw.from], GIT);
        if (made.ok) { pin = ref; pinned.set(rw.from, ref); }
      }
    }
    const moved = rw.to ? `moved from ${rw.from.slice(0, 10)} to ${rw.to.slice(0, 10)}` : `was deleted at ${rw.from.slice(0, 10)}`;
    const kindWord = rw.kind === 'deleted' ? 'deleted' : rw.kind === 'non-fast-forward' ? 'non-fast-forward' : 'ancestry cannot be confirmed';
    const summary = `${rw.ref} ${moved} (${kindWord})`;
    const reason = pin
      ? `Recorded, not blocked: ${rw.ref} no longer contains ${rw.from.slice(0, 10)}, so Wanigan pinned it as ${pin} where git gc cannot collect it.`
      : `Recorded, not blocked: ${rw.ref} no longer contains ${rw.from.slice(0, 10)}, and Wanigan could not pin it — the object is already gone or the ref could not be written.`;
    try {
      recordEvidenceRow({ sessionId, projectId, trust, toolName: 'git', summary, rule: 'evidence.git-rewrite', reason });
    } catch { /* the signal below still carries it */ }
    signal(sessionId, projectId, 'git-rewrite', 'evidence.git-rewrite', summary, { ...rw, pinnedAs: pin, root: state.root });
  }
}

function enqueue(state: State, job: () => Promise<void>): void {
  state.chain = state.chain.then(job, job).catch(() => { /* one failed pass must not stop the next */ });
}

/** Fed every stored hook event with its body. */
export function observeForRewrites(stored: SessionEvent, input: HookInput, cwd: string | null): void {
  const sessionId = stored.sessionId;
  if (stored.event === 'PreToolUse') {
    const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
    const found = command ? rewriteCommandsIn(command) : [];
    if (found.length) {
      const { projectId } = projectOf(sessionId);
      signal(sessionId, projectId, 'git-rewrite-command', `evidence.git-rewrite-command`,
        `${[...new Set(found.map((f) => f.kind))].join(', ')}: ${found[0].text}`.slice(0, 400), { kinds: found.map((f) => f.kind) });
    }
  }

  const state = states.get(sessionId);
  if (!state) {
    if (stored.event === 'SessionEnd') return;
    if (states.size >= MAX_STATES) {
      const oldest = states.keys().next();
      if (!oldest.done) states.delete(oldest.value);
    }
    const pending: State = { root: '', snapshot: { refs: {} }, chain: Promise.resolve() };
    states.set(sessionId, pending);
    enqueue(pending, async () => {
      const root = await rootFor(sessionId, cwd);
      const snap = root ? await snapshot(root) : null;
      if (!root || !snap) { states.delete(sessionId); return; }
      pending.root = root;
      pending.snapshot = snap;
    });
    return;
  }
  if (stored.event === 'Stop' || stored.event === 'SessionEnd') {
    const s = state;
    enqueue(s, async () => { if (s.root) await compareAndPin(sessionId, s); });
    if (stored.event === 'SessionEnd') {
      void s.chain.then(() => { if (states.get(sessionId) === s) states.delete(sessionId); });
    }
  }
}

/**
 * Every repository a session pinned evidence in, from its own signal rows —
 * the one place the root was written down, since a session with no checkpoint
 * rows has nothing else that names its repository.
 */
function evidenceRoots(sessionId: string): string[] {
  try {
    const rows = db().prepare("SELECT detail_json FROM policy_signals WHERE session_id = ? AND kind = 'git-rewrite'").all(sessionId) as { detail_json: string | null }[];
    const roots = new Set<string>();
    for (const r of rows) {
      try { const root = (JSON.parse(r.detail_json ?? '{}') as { root?: unknown }).root; if (typeof root === 'string') roots.add(root); } catch { /* skip */ }
    }
    return [...roots];
  } catch { return []; }
}

/**
 * Remove a session's evidence refs, alongside its checkpoint refs. The ledger
 * rows and signals stay — they are the record that a rewrite happened — and a
 * `git-rewrite-pruned` signal says the pins themselves were retired.
 */
export async function forgetEvidenceRefs(sessionId: string, knownRoots: string[] = []): Promise<number> {
  const prefix = evidenceRefPrefix(sessionId);
  let removed = 0;
  for (const root of new Set([...knownRoots, ...evidenceRoots(sessionId)])) {
    if (!fs.existsSync(root)) continue;
    const refs = await runGit(root, ['for-each-ref', '--format=%(refname)', prefix], GIT);
    for (const ref of refs.ok ? refs.out.split('\n').filter(Boolean) : []) {
      if (!ref.startsWith(prefix)) continue;
      const r = await runGit(root, ['update-ref', '-d', ref], GIT);
      if (r.ok) removed += 1;
    }
  }
  if (evidenceRoots(sessionId).length) signal(sessionId, null, 'git-rewrite-pruned', 'evidence.git-rewrite', `${removed} evidence ref${removed === 1 ? '' : 's'} retired by retention`, { removed });
  return removed;
}

/** Sessions whose evidence pins are older than the cutoff and not yet retired. */
export function staleEvidenceSessions(cutoff: number, limit: number): string[] {
  try {
    return (db().prepare(`
      SELECT session_id FROM policy_signals
       WHERE kind IN ('git-rewrite', 'git-rewrite-pruned') AND session_id IS NOT NULL
       GROUP BY session_id
      HAVING MAX(CASE WHEN kind = 'git-rewrite' THEN at END) < ?
         AND COALESCE(MAX(CASE WHEN kind = 'git-rewrite-pruned' THEN at END), 0) < MAX(CASE WHEN kind = 'git-rewrite' THEN at END)
       LIMIT ?
    `).all(cutoff, limit) as { session_id: string }[]).map((r) => r.session_id);
  } catch { return []; }
}

/** For the offline smoke suite: wait until a session's queued snapshots and comparisons finish. */
export async function rewriteEvidenceIdle(sessionId: string): Promise<void> {
  const s = states.get(sessionId);
  if (s) await s.chain;
}
