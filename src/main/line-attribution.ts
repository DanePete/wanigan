import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dialog, type BrowserWindow } from 'electron';
import { db } from './db';
import { runGit } from './git';
import { repoRootFor } from './worktrees';
import {
  addedRangesFromDiff, annotate, authorshipNote, inRanges, isUncommitted, mergeRanges, parseBlamePorcelain, rangeLines, turnForCommitByTree,
  type AnnotatedRange, type AttributionSummary, type Author, type NoteEntry, type Range,
} from '../shared/line-attribution';

/**
 * Line-level attribution, computed locally: the lines a session added, per
 * commit and per checkpointed turn, stored as ranges in SQLite; "who wrote
 * this" for a file as it is now; how many of a session's committed lines git
 * still finds; and, on an explicit confirmation, Git AI authorship notes under
 * refs/notes/ai in the local repository — never pushed, never overwriting a
 * note that is already there. See shared/line-attribution.ts for the rules.
 */

const MAX_COMMITS = 500;
const MAX_FILES_SURVIVAL = 200;
const LIFETIME_SLACK_MS = 60_000;
const DIFF_BUFFER = 64 * 1024 * 1024;
export const NOTES_REF = 'refs/notes/ai';

type SessionRow = {
  id: string; conversation_id: string | null; provider_id: string; harness_id: string | null; project_path: string; project_name: string;
  worktree: string | null; baseline_head: string | null; started_at: number; ended_at: number | null; title: string | null; model: string | null;
};

type CheckpointRow = { turn: number; kind: string; at: number; commit_hash: string | null; status: string };

let windowFor: () => BrowserWindow | null = () => null;
let confirmOverride: ((input: { commits: number; ref: string; repo: string }) => Promise<boolean>) | null = null;

export function setAttributionWindow(fn: () => BrowserWindow | null): void {
  windowFor = fn;
}

/** For the offline suite, which cannot click the export confirmation. */
export function setAttributionConfirm(fn: ((input: { commits: number; ref: string; repo: string }) => Promise<boolean>) | null): void {
  confirmOverride = fn;
}

function sessionRow(sessionId: unknown): SessionRow {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) throw new Error('Choose a session.');
  const row = db().prepare(`SELECT id, conversation_id, provider_id, harness_id, project_path, project_name, worktree, baseline_head,
                                   started_at, ended_at, title, model FROM session_log WHERE id = ?`).get(sessionId) as SessionRow | undefined;
  if (!row) throw new Error('That session is not in Wanigan’s records.');
  return row;
}

function checkoutOf(row: SessionRow): string {
  const dir = row.worktree && fs.existsSync(row.worktree) ? row.worktree : row.project_path;
  if (!fs.existsSync(dir)) throw new Error('This session’s checkout no longer exists, so git cannot be asked about it.');
  return dir;
}

function checkpoints(sessionId: string): CheckpointRow[] {
  return db().prepare(`SELECT turn, kind, at, commit_hash, status FROM session_checkpoints
                        WHERE session_id = ? AND status IN ('ok','skipped-unchanged') AND commit_hash IS NOT NULL ORDER BY at, id`)
    .all(sessionId) as CheckpointRow[];
}

/* ── computing ───────────────────────────────────────────────────────── */

type StoredRange = { commit: string; origin: 'commit' | 'checkpoint'; turn: number | null; file: string; ranges: Range[] };

async function commitsInLifetime(cwd: string, row: SessionRow): Promise<{ hash: string; at: number }[]> {
  const head = (await runGit(cwd, ['rev-parse', '--verify', 'HEAD'], { timeout: 8_000 })).out.trim();
  if (!head) return [];
  const range = row.baseline_head && row.baseline_head !== head ? [`${row.baseline_head}..${head}`] : row.baseline_head ? [] : [head];
  if (!range.length) return [];
  const log = await runGit(cwd, ['log', '--reverse', '--no-merges', `--max-count=${MAX_COMMITS}`, '--format=%H%x09%ct', ...range], { timeout: 30_000 });
  if (!log.ok) return [];
  const from = row.started_at - LIFETIME_SLACK_MS;
  const to = (row.ended_at ?? Date.now()) + LIFETIME_SLACK_MS;
  return log.out.split('\n').map((l) => l.split('\t')).filter((p) => /^[0-9a-f]{40}$/.test(p[0] ?? ''))
    .map(([hash, ct]) => ({ hash, at: Number(ct) * 1000 }))
    .filter((c) => c.at >= from && c.at <= to);
}

async function diffRanges(cwd: string, from: string | null, to: string): Promise<Map<string, Range[]>> {
  const args = from
    ? ['diff', '-U0', '--no-color', '--no-ext-diff', '-M', from, to]
    : ['show', '--format=', '-U0', '--no-color', '--no-ext-diff', '-M', to];
  const r = await runGit(cwd, args, { timeout: 60_000, maxBuffer: DIFF_BUFFER });
  return r.ok ? addedRangesFromDiff(r.out) : new Map();
}

export async function computeAttribution(sessionId: unknown): Promise<AttributionSummary> {
  const row = sessionRow(sessionId);
  const cwd = checkoutOf(row);
  const root = await repoRootFor(cwd);
  if (!root) throw new Error('This session did not run in a git repository, so there is nothing to attribute.');

  const cps = checkpoints(row.id);
  const turnSpans = cps.filter((c) => c.kind === 'turn-start').map((c) => ({
    turn: c.turn, startAt: c.at,
    endAt: cps.find((e) => e.turn === c.turn && (e.kind === 'turn-end' || e.kind === 'session-end') && e.at >= c.at)?.at ?? null,
  }));
  const stored: StoredRange[] = [];

  // Commits are attributed only on a session's own worktree branch. In the
  // project checkout the operator commits too, and "made while the session
  // was running" would hand their commits to the agent.
  const commits = row.worktree ? await commitsInLifetime(cwd, row) : [];
  // The tree each turn ended with, read only when there are commits to place:
  // a commit of exactly that tree was made from that turn's work, and git's
  // one-second commit time cannot always say which side of a boundary it fell.
  const treeOf = async (rev: string) => (await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], { timeout: 8_000 })).out.trim() || null;
  const turnEnds: { turn: number; tree: string | null }[] = [];
  if (commits.length) {
    for (const span of turnSpans) {
      const end = [...cps].reverse().find((e) => e.turn === span.turn && (e.kind === 'turn-end' || e.kind === 'session-end') && e.commit_hash);
      if (end?.commit_hash) turnEnds.push({ turn: span.turn, tree: await treeOf(end.commit_hash) });
    }
  }
  for (const c of commits) {
    const parent = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${c.hash}^`], { timeout: 8_000 })).out.trim() || null;
    const ranges = await diffRanges(cwd, parent, c.hash);
    const turn = turnForCommitByTree(await treeOf(c.hash), turnEnds, turnSpans, c.at);
    for (const [file, r] of ranges) stored.push({ commit: c.hash, origin: 'commit', turn, file, ranges: r });
  }

  // Per turn: what changed between that turn's start and end checkpoints.
  let addedByTurns: number | null = null;
  const turns = [...new Set(cps.map((c) => c.turn))].filter((t) => t > 0).sort((a, b) => a - b);
  for (const turn of turns) {
    const start = cps.find((c) => c.turn === turn && c.kind === 'turn-start');
    const end = [...cps].reverse().find((c) => c.turn === turn && (c.kind === 'turn-end' || c.kind === 'session-end'));
    if (!start?.commit_hash || !end?.commit_hash) continue;
    addedByTurns ??= 0;
    if (start.commit_hash === end.commit_hash) continue;
    const ranges = await diffRanges(root, start.commit_hash, end.commit_hash);
    for (const [file, r] of ranges) {
      stored.push({ commit: end.commit_hash, origin: 'checkpoint', turn, file, ranges: r });
      addedByTurns += rangeLines(r);
    }
  }

  const addedInCommits = stored.filter((s) => s.origin === 'commit').reduce((n, s) => n + rangeLines(s.ranges), 0);
  const d = db();
  d.transaction(() => {
    d.prepare('DELETE FROM line_attribution WHERE session_id = ?').run(row.id);
    const insert = d.prepare('INSERT INTO line_attribution (session_id, commit_hash, origin, turn, file, start_line, end_line) VALUES (?,?,?,?,?,?,?)');
    for (const s of stored) for (const [a, b] of s.ranges) insert.run(row.id, s.commit, s.origin, s.turn, s.file, a, b);
    d.prepare(`INSERT INTO line_attribution_runs (session_id, computed_at, repo_root, base, head, lines_added, commits, detail) VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(session_id) DO UPDATE SET computed_at=excluded.computed_at, repo_root=excluded.repo_root, base=excluded.base,
               head=excluded.head, lines_added=excluded.lines_added, commits=excluded.commits, detail=excluded.detail`)
      .run(row.id, Date.now(), root, row.baseline_head, commits.at(-1)?.hash ?? null, addedByTurns ?? addedInCommits, commits.length,
        [addedByTurns === null ? 'no checkpoints recorded' : null, row.worktree ? null : 'ran in the project checkout, so commits are not attributed']
          .filter(Boolean).join('; ') || null);
  })();
  return attributionSummary(row.id);
}

/* ── reading ─────────────────────────────────────────────────────────── */

function storedFor(sessionId: string, origin?: 'commit' | 'checkpoint'): StoredRange[] {
  const rows = db().prepare(`SELECT commit_hash, origin, turn, file, start_line, end_line FROM line_attribution WHERE session_id = ?${origin ? ' AND origin = ?' : ''}`)
    .all(...(origin ? [sessionId, origin] : [sessionId])) as { commit_hash: string; origin: 'commit' | 'checkpoint'; turn: number | null; file: string; start_line: number; end_line: number }[];
  const byKey = new Map<string, StoredRange>();
  for (const r of rows) {
    const key = `${r.commit_hash} ${r.file} ${r.origin} ${r.turn}`;
    const entry = byKey.get(key) ?? { commit: r.commit_hash, origin: r.origin, turn: r.turn, file: r.file, ranges: [] };
    entry.ranges.push([r.start_line, r.end_line]);
    byKey.set(key, entry);
  }
  return [...byKey.values()].map((e) => ({ ...e, ranges: mergeRanges(e.ranges) }));
}

/** Of the session's committed lines, how many git blame still finds, on its base branch if merged there, else on the branch itself. */
async function survival(row: SessionRow, commitsRanges: StoredRange[]): Promise<AttributionSummary['stillPresent']> {
  if (!commitsRanges.length) return null;
  const cwd = checkoutOf(row);
  const branch = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 8_000 })).out.trim();
  const head = (await runGit(cwd, ['rev-parse', 'HEAD'], { timeout: 8_000 })).out.trim();
  const base = branch && branch !== 'HEAD' ? (await runGit(cwd, ['config', '--get', `branch.${branch}.waniganbase`], { timeout: 8_000 })).out.trim() : '';
  let target = head;
  let label = `${branch && branch !== 'HEAD' ? branch : 'HEAD'} at ${head.slice(0, 7)}`;
  let merged = false;
  if (base) {
    const contained = await runGit(cwd, ['merge-base', '--is-ancestor', head, base], { timeout: 15_000 });
    if (contained.ok) {
      const baseHead = (await runGit(cwd, ['rev-parse', base], { timeout: 8_000 })).out.trim();
      if (baseHead) { target = baseHead; label = `${base} at ${baseHead.slice(0, 7)}, where it was merged`; merged = true; }
    }
  }
  const byCommitFile = new Map(commitsRanges.map((s) => [`${s.commit} ${s.file}`, s.ranges] as const));
  const commits = new Set(commitsRanges.map((s) => s.commit));
  let lines = 0;
  for (const file of [...new Set(commitsRanges.map((s) => s.file))].slice(0, MAX_FILES_SURVIVAL)) {
    const blame = await runGit(cwd, ['blame', '--porcelain', target, '--', file], { timeout: 30_000, maxBuffer: DIFF_BUFFER });
    if (!blame.ok) continue; // gone at the target: none of its lines survived
    for (const l of parseBlamePorcelain(blame.out)) {
      if (commits.has(l.commit) && inRanges(byCommitFile.get(`${l.commit} ${l.file || file}`), l.origLine)) lines++;
    }
  }
  return { lines, target: label, merged };
}

export async function attributionSummary(sessionId: unknown): Promise<AttributionSummary> {
  const row = sessionRow(sessionId);
  const run = db().prepare('SELECT computed_at, commits, detail FROM line_attribution_runs WHERE session_id = ?').get(row.id) as { computed_at: number; commits: number; detail: string | null } | undefined;
  if (!run) return { sessionId: row.id, computedAt: null, addedByTurns: null, addedInCommits: 0, commits: 0, stillPresent: null, note: 'Not computed yet.' };
  const commitRanges = storedFor(row.id, 'commit');
  const turnRanges = storedFor(row.id, 'checkpoint');
  let stillPresent: AttributionSummary['stillPresent'] = null;
  let note = run.detail;
  try { stillPresent = await survival(row, commitRanges); } catch (e) { note = e instanceof Error ? e.message : String(e); }
  return {
    sessionId: row.id,
    computedAt: run.computed_at,
    addedByTurns: run.detail?.includes('no checkpoints recorded') ? null : turnRanges.reduce((n, s) => n + rangeLines(s.ranges), 0),
    addedInCommits: commitRanges.reduce((n, s) => n + rangeLines(s.ranges), 0),
    commits: run.commits,
    stillPresent,
    note,
  };
}

function safeRel(cwd: string, rel: unknown): string {
  if (typeof rel !== 'string' || !rel || rel.length > 4_096 || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    throw new Error('Choose a file inside this session’s checkout.');
  }
  const abs = path.resolve(cwd, rel);
  const real = fs.realpathSync(abs);
  const base = fs.realpathSync(cwd);
  if (real !== base && !real.startsWith(base + path.sep)) throw new Error('That file resolves outside this session’s checkout.');
  return rel;
}

/**
 * Who wrote each line of a file as it is now. Committed lines are mapped
 * through any session's stored commit ranges; uncommitted lines through this
 * session's checkpoint chain, to the turn whose end checkpoint first held them.
 */
export async function attributionForFile(sessionId: unknown, relInput: unknown): Promise<{ ranges: AnnotatedRange[]; lines: number; unmarked: number; note: string | null }> {
  const row = sessionRow(sessionId);
  const cwd = checkoutOf(row);
  const rel = safeRel(cwd, relInput);
  const d = db();
  const titleOf = new Map<string, string>();
  const title = (id: string) => {
    if (!titleOf.has(id)) {
      const r = d.prepare('SELECT title, project_name FROM session_log WHERE id = ?').get(id) as { title: string | null; project_name: string } | undefined;
      titleOf.set(id, r?.title || r?.project_name || id);
    }
    return titleOf.get(id)!;
  };

  const blame = await runGit(cwd, ['blame', '--porcelain', '--', rel], { timeout: 30_000, maxBuffer: DIFF_BUFFER });
  let lines = blame.ok ? parseBlamePorcelain(blame.out) : [];
  let note: string | null = blame.ok ? null : 'git blame could not read this file as committed; only this session’s checkpoints were consulted.';

  const commitAuthors = new Map<string, { sessionId: string; turn: number | null; file: string; ranges: Range[] }[]>();
  const committed = [...new Set(lines.filter((l) => !isUncommitted(l.commit)).map((l) => l.commit))];
  for (let i = 0; i < committed.length; i += 400) {
    const chunk = committed.slice(i, i + 400);
    const rows = d.prepare(`SELECT session_id, commit_hash, turn, file, start_line, end_line FROM line_attribution
                             WHERE origin = 'commit' AND commit_hash IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as
      { session_id: string; commit_hash: string; turn: number | null; file: string; start_line: number; end_line: number }[];
    for (const r of rows) {
      const list = commitAuthors.get(r.commit_hash) ?? [];
      const hit = list.find((x) => x.sessionId === r.session_id && x.file === r.file && x.turn === r.turn);
      if (hit) hit.ranges.push([r.start_line, r.end_line]);
      else list.push({ sessionId: r.session_id, turn: r.turn, file: r.file, ranges: [[r.start_line, r.end_line]] });
      commitAuthors.set(r.commit_hash, list);
    }
  }

  // Uncommitted lines, or the whole file when blame could not read it, are
  // asked of this session's checkpoint chain against the file on disk.
  const cps = checkpoints(row.id);
  const turnOfCheckpoint = new Map<string, number>();
  for (const c of cps) if (c.commit_hash && c.kind === 'turn-end' && c.status === 'ok' && !turnOfCheckpoint.has(c.commit_hash)) turnOfCheckpoint.set(c.commit_hash, c.turn);
  const checkpointLine = new Map<number, number>();
  const last = cps.at(-1)?.commit_hash;
  const needsCheckpoints = !blame.ok || lines.some((l) => isUncommitted(l.commit));
  if (last && needsCheckpoints) {
    // The checkout's own top level, not repoRootFor: for a worktree that
    // answers the main repository, and a path relative to it points outside
    // the worktree the checkpoints were captured from.
    const top = (await runGit(cwd, ['rev-parse', '--show-toplevel'], { timeout: 8_000 })).out.trim() || cwd;
    const relToTop = path.relative(fs.realpathSync(top), fs.realpathSync(path.resolve(cwd, rel)));
    const cb = await runGit(top, ['blame', '--porcelain', '--contents', path.resolve(cwd, rel), last, '--', relToTop], { timeout: 30_000, maxBuffer: DIFF_BUFFER });
    if (cb.ok) {
      const cpLines = parseBlamePorcelain(cb.out);
      for (const l of cpLines) {
        const turn = turnOfCheckpoint.get(l.commit);
        if (turn !== undefined) checkpointLine.set(l.finalLine, turn);
      }
      if (!blame.ok) lines = cpLines.map((l) => ({ ...l, commit: '0'.repeat(40) }));
    }
  } else if (needsCheckpoints && !last) {
    note = note ?? 'This session recorded no checkpoints, so uncommitted lines cannot be attributed to a turn.';
  }

  const authorOf = (l: { commit: string; origLine: number; file: string; finalLine: number }): Author | null => {
    if (isUncommitted(l.commit)) {
      const turn = checkpointLine.get(l.finalLine);
      return turn === undefined ? null : { sessionId: row.id, title: title(row.id), turn, origin: 'checkpoint' };
    }
    const candidates = commitAuthors.get(l.commit) ?? [];
    const hit = candidates.find((c) => (c.file === l.file || c.file === rel) && inRanges(mergeRanges(c.ranges), l.origLine)) ?? null;
    return hit ? { sessionId: hit.sessionId, title: title(hit.sessionId), turn: hit.turn, origin: 'commit' } : null;
  };
  const ranges = annotate(lines, authorOf);
  const marked = ranges.reduce((n, r) => n + r.end - r.start + 1, 0);
  return { ranges, lines: lines.length, unmarked: Math.max(0, lines.length - marked), note };
}

/* ── git notes ───────────────────────────────────────────────────────── */

function hex14(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 14);
}

function toolOf(row: SessionRow): string {
  const harness = row.harness_id?.trim() || (row.provider_id === 'codex' ? 'codex' : 'claude-code');
  return harness === 'claude-code' ? 'claude' : harness;
}

/**
 * Write an authorship note for each of this session's attributed commits under
 * refs/notes/ai, after the operator confirms. A commit that already carries a
 * note on that ref is left alone and counted, never overwritten; nothing is
 * pushed, and no prompt or transcript text is written.
 */
export async function exportGitNotes(sessionId: unknown): Promise<{ written: number; skipped: number; ref: string; cancelled?: boolean }> {
  const row = sessionRow(sessionId);
  const cwd = checkoutOf(row);
  const byCommit = new Map<string, StoredRange[]>();
  for (const s of storedFor(row.id, 'commit')) byCommit.set(s.commit, [...(byCommit.get(s.commit) ?? []), s]);
  if (!byCommit.size) throw new Error('No commits made during this session are attributed yet. Compute attribution first; uncommitted work has no commit to note.');
  const ok = confirmOverride
    ? await confirmOverride({ commits: byCommit.size, ref: NOTES_REF, repo: cwd })
    : await (async () => {
      const w = windowFor();
      const options = {
        type: 'question' as const, buttons: ['Cancel', 'Write notes'], defaultId: 0, cancelId: 0,
        title: 'Export attribution as git notes?',
        message: `Write authorship notes for ${byCommit.size} commit${byCommit.size === 1 ? '' : 's'} under ${NOTES_REF}?`,
        detail: `In ${cwd}. Notes are local repository metadata in the Git AI authorship format: file line ranges and the agent session, never a prompt. `
          + 'A commit that already has a note there is skipped, not overwritten. Nothing is pushed; `git push origin refs/notes/ai` would be your own decision.',
      };
      const r = w ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options);
      return r.response === 1;
    })();
  if (!ok) return { written: 0, skipped: 0, ref: NOTES_REF, cancelled: true };

  const sessionKey = `s_${hex14(`${toolOf(row)}:${row.conversation_id ?? row.id}`)}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-notes-'));
  let written = 0;
  let skipped = 0;
  try {
    for (const [commit, ranges] of byCommit) {
      const existing = await runGit(cwd, ['notes', `--ref=${NOTES_REF}`, 'show', commit], { timeout: 8_000 });
      if (existing.ok) { skipped++; continue; }
      const entries: NoteEntry[] = ranges.map((s) => ({ file: s.file, key: `${sessionKey}::t_${hex14(`${row.id}:${commit}:${s.turn ?? ''}`)}`, ranges: s.ranges }));
      const text = authorshipNote({
        baseCommit: commit, generator: 'wanigan', entries,
        sessions: [{ key: entries[0].key, tool: toolOf(row), id: row.conversation_id ?? row.id, model: row.model }],
      });
      const file = path.join(tmp, `${commit}.txt`);
      fs.writeFileSync(file, text);
      const add = await runGit(cwd, ['notes', `--ref=${NOTES_REF}`, 'add', '-F', file, commit], { timeout: 15_000 });
      if (add.ok) written++; else skipped++;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { written, skipped, ref: NOTES_REF };
}
