// A checkpoint per turn. When an agent session starts and when each of its
// turns ends, git records the session's folder: a copy of the real index is
// staged into with `add -A` (so .gitignore holds), written as a tree, and
// wrapped in a commit that no ref points at. The working tree, the real index,
// HEAD, refs and the stash are never touched, and nothing is written into the
// repository's .git either: new objects go to Wanigan's own object store for
// that repository, which reads the repository's objects as an alternate.
// Untracked files over a size are left out. Undoing the last turn is the one
// write, to the working tree only, and only once nothing else has changed the
// folder since, and never deleting a file that was there before the turn.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { copyFile, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  capitalise, turnName, undoSummary, whyNotUndo,
  type Checkpoint, type CheckpointKind, type SessionCheckpoints, type TurnChanges, type TurnFile,
} from '../shared/checkpoints.ts';
import { OWNER, type Provider, type SessionState } from '../shared/model.ts';
import { CoreError } from '../shared/protocol.ts';
import type { Board } from './board.ts';
import type { Ctx } from './context.ts';
import { changedFiles, gitMissing } from './git.ts';
import { withGitMutation } from './git-lock.ts';
import { LIVE_SQL } from './records.ts';

/** How long one snapshot may take before it is skipped and recorded as not captured. */
const CAPTURE_MS = 5_000;
/** Files whose diffs a turn's changes carry; the rest are listed without one. */
const MAX_DIFF_FILES = 200;
const MAX_FILE_DIFF = 200_000;
const MAX_TOTAL_DIFF = 2_000_000;
/** Untracked files bigger than this are left out of a checkpoint (a database, a build, a download). */
const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024;
/** How many large untracked files a checkpoint will name to leave out; past this it is not captured. */
const MAX_LEFT_OUT = 200;
/** Git's own variables that would point it at another repository or index. */
const GIT_REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX'];
/** Checkpoint commits are Wanigan's, not the owner's: they never carry the owner's name or a signature. */
const IDENTITY = { GIT_AUTHOR_NAME: 'Wanigan', GIT_AUTHOR_EMAIL: 'wanigan@localhost', GIT_COMMITTER_NAME: 'Wanigan', GIT_COMMITTER_EMAIL: 'wanigan@localhost' };
/** Diff output that does not depend on the owner's git configuration, so it applies and parses the same everywhere. */
const PLAIN_DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/'];

interface Row {
  id: number; session_id: string; kind: CheckpointKind; turn: number; event_id: number | null; cwd: string;
  commit_sha: string | null; tree_sha: string | null; head_sha: string | null; before_sha: string | null;
  not_captured: string | null; shared: number; files: number | null; additions: number | null; deletions: number | null; at: number;
}

interface SessionFacts {
  id: string; project_id: string; card_id: string | null; provider: Provider; state: SessionState; title: string;
  cwd: string | null; started_at: number; project_path: string;
}

/** What git recorded of a folder: the tree, the commit wrapping it (when asked for), HEAD, and the repository's top. */
interface Shot { tree: string; commit: string | null; head: string | null; top: string }

export class Checkpoints {
  private readonly ctx: Ctx;
  private readonly board: Board;
  private readonly tmp: string;
  /** Wanigan's object stores, one per repository: checkpoints never write into a repository's .git. */
  private readonly objects: string;
  private readonly worktrees: string;
  private readonly timeoutMs: number;
  /** One job at a time per session, in order: a capture, a check, an undo. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();
  /** Files changed between two checkpoints, by "before..after": commits never change, so neither does this. */
  private readonly touchedCache = new Map<string, string[]>();
  private closed = false;

  constructor(ctx: Ctx, board: Board, options: { dataDir: string; timeoutMs?: number }) {
    this.ctx = ctx;
    this.board = board;
    this.tmp = join(options.dataDir, 'checkpoints');
    this.objects = join(options.dataDir, 'checkpoint-objects');
    this.worktrees = join(options.dataDir, 'worktrees');
    this.timeoutMs = options.timeoutMs ?? CAPTURE_MS;
    // Temporary indexes a previous core left behind when it stopped mid-capture.
    rmSync(this.tmp, { recursive: true, force: true });
    mkdirSync(this.tmp, { recursive: true, mode: 0o700 });
    mkdirSync(this.objects, { recursive: true, mode: 0o700 });
  }

  /** An agent session started: its folder before the first turn. */
  started(sessionId: string): void {
    void this.queue(sessionId, () => this.capture(sessionId, 'start', null)).catch(() => {});
  }

  /**
   * A turn ended (Claude's Stop, Codex's "turn complete"). Queued, so the hook
   * that reported it is answered before git starts. Resolves once it is
   * recorded (each capture is time-limited), so the next message can wait for
   * it and the next turn's edits never land in this turn's checkpoint.
   */
  turnEnded(sessionId: string, eventId: number): Promise<void> {
    return this.queue(sessionId, () => this.capture(sessionId, 'turn', eventId)).catch(() => {});
  }

  /** Resolves once every capture asked for so far has finished. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Stop taking checkpoints, and wait for the ones under way (each is time-limited). */
  async close(): Promise<void> {
    this.closed = true;
    await this.settled();
  }

  /** A session's checkpoints, oldest first, and whether its last turn can be undone (or redone) now. */
  list(sessionId: string): Promise<SessionCheckpoints> {
    this.session(sessionId);
    return this.queue(sessionId, async () => {
      const session = this.session(sessionId);
      const rows = this.rows(session.id);
      const last = rows.at(-1);
      if (!last || last.kind === 'start') return { checkpoints: rows.map(toCheckpoint), last: null };
      const { refusal } = await this.assess(session, rows, false);
      const original = last.kind === 'turn' ? last : rows.findLast((r) => r.kind === 'turn' && r.event_id === last.event_id && r.id < last.id);
      return {
        checkpoints: rows.map(toCheckpoint),
        last: {
          action: last.kind === 'undo' ? 'redo' : 'undo', turn: last.turn, checkpointId: last.id, turnCheckpointId: original?.id ?? null,
          eventId: last.event_id, files: last.files, refusal,
        },
      };
    });
  }

  /** What one checkpoint changed against the one before it: each file, with its diff (bounded). */
  async changes(sessionId: string, checkpointId: number): Promise<TurnChanges> {
    const session = this.session(sessionId);
    const rows = this.rows(session.id);
    const row = rows.find((r) => r.id === checkpointId);
    if (!row) throw new CoreError('not_found', 'No such checkpoint in this session.');
    const previous = rows.filter((r) => r.id < row.id).at(-1);
    const empty: TurnChanges = {
      checkpointId: row.id, turn: row.turn, gone: null, files: [], additions: 0, deletions: 0, shared: row.shared === 1,
      includes: row.kind === 'turn' && previous?.not_captured && previous.kind === 'turn'
        ? `${capitalise(turnName(previous.turn))} was not captured, so its changes are in here too.` : null,
    };
    if (row.not_captured) return { ...empty, gone: `This turn was not captured: ${row.not_captured}.` };
    if (!row.before_sha || !row.commit_sha) return { ...empty, gone: 'There is no checkpoint from before this turn, so what it changed is unknown.' };
    const top = await this.topOf(existsSync(row.cwd) ? row.cwd : session.project_path);
    if (!top) return { ...empty, gone: 'The folder is no longer a git repository, so the checkpoint cannot be read.' };
    const env = await storeFor(top, this.objects);
    if (!(await has(top, row.before_sha, env)) || !(await has(top, row.commit_sha, env))) {
      return { ...empty, gone: 'Git no longer has this checkpoint (Wanigan’s copy was removed, or the repository dropped what it was built on), so what this turn changed cannot be shown.' };
    }
    const range = [row.before_sha, row.commit_sha];
    const [names, numstat] = await Promise.all([
      run(top, [...PLAIN_DIFF, '--name-status', '-z', ...range], { env }),
      run(top, [...PLAIN_DIFF, '--numstat', '-z', ...range], { env }),
    ]);
    const listed = changedFiles(names, numstat).sort((a, b) => a.path.localeCompare(b.path));
    let budget = MAX_TOTAL_DIFF;
    const files: TurnFile[] = [];
    for (const [i, f] of listed.entries()) {
      const { from, ...file } = f;
      let diff: string | null = null;
      let truncated = false;
      if (!file.binary && i < MAX_DIFF_FILES && budget > 0) {
        const paths = [file.path, ...(from ? [from] : [])].map((p) => `:(top,literal)${p}`);
        // A diff git could not produce (over its output limit, say) is shown as too much to show, never as empty.
        const text = await run(top, [...PLAIN_DIFF, ...range, '--', ...paths], { env }).catch(() => null);
        if (text !== null) {
          const limit = Math.min(MAX_FILE_DIFF, budget);
          truncated = text.length > limit;
          diff = truncated ? text.slice(0, limit) : text;
          budget -= diff.length;
        }
      }
      files.push({ ...file, diff, truncated });
    }
    return {
      ...empty, files,
      additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    };
  }

  /**
   * Undo the last turn, or redo an undo: put the files it changed back, in the
   * working tree only. Refused unless the folder still matches the last
   * checkpoint. The state before is checkpointed first, so this can be reversed.
   */
  revert(sessionId: string, checkpointId: number, action: 'undo' | 'redo'): Promise<{ turn: number; files: string[] }> {
    this.session(sessionId);
    return this.queue(sessionId, () => withGitMutation(this.session(sessionId).cwd ?? this.session(sessionId).project_path, async () => {
      const session = this.session(sessionId);
      const rows = this.rows(session.id);
      const last = rows.at(-1);
      const offered = !last || last.kind === 'start' ? null : last.kind === 'undo' ? 'redo' : 'undo';
      if (!last || last.id !== checkpointId || offered !== action) {
        throw new CoreError('conflict', 'The session has moved on since this was shown. Look again.');
      }
      const { refusal, now } = await this.assess(session, rows, true);
      if (refusal || !now?.commit || !last.commit_sha || !last.before_sha) throw new CoreError('refused', refusal ?? 'There is nothing to go back to.');
      const env = await storeFor(now.top, this.objects);
      const patch = await run(now.top, [...PLAIN_DIFF, '--binary', '--full-index', last.commit_sha, last.before_sha], { env });
      const files = changedFiles(await run(now.top, [...PLAIN_DIFF, '--name-status', '-z', last.commit_sha, last.before_sha], { env }), '').map((f) => f.path);
      if (!patch.trim()) throw new CoreError('refused', `${capitalise(turnName(last.turn))} changed no files.`);
      // git apply is all or nothing: on any conflict it changes nothing.
      await run(now.top, ['apply', '--whitespace=nowarn', '-'], { input: patch, env }).catch((error: Error) => {
        throw new CoreError('refused', `Git could not apply it cleanly, so nothing was changed: ${firstLine(error)}`);
      });
      const after = await snapshot(now.top, this.tmp, this.timeoutMs, true, this.objects);
      const kind = action === 'undo' ? 'undo' : 'redo';
      this.insert({
        session_id: session.id, kind, turn: last.turn, event_id: last.event_id, cwd: last.cwd,
        ...('reason' in after
          ? { not_captured: after.reason }
          : { commit_sha: after.commit, tree_sha: after.tree, head_sha: after.head, before_sha: now.commit, files: files.length }),
      });
      const summary = undoSummary(action, last.turn, files.length);
      this.ctx.db.prepare('INSERT INTO session_events (session_id, at, event, tool, summary, path) VALUES (?, ?, ?, NULL, ?, NULL)')
        .run(session.id, this.ctx.now(), action === 'undo' ? 'Undo' : 'Redo', summary);
      this.board.log({ projectId: session.project_id, cardId: session.card_id, sessionId: session.id, actor: OWNER, verb: action === 'undo' ? 'undid a turn' : 'redid a turn', detail: `${summary} (${session.title})` });
      this.ctx.emit('sessions', { projectId: session.project_id, sessionId: session.id });
      return { turn: last.turn, files };
    }));
  }

  /**
   * Which files each session's turns changed in the folder `cwd` since `since`,
   * as its checkpoints recorded: path → the sessions and turns that touched
   * it. A turn the owner undid (and did not redo) is left out. Read-only, and
   * each pair of checkpoints is diffed once: they never change.
   */
  async touched(cwd: string, since: number): Promise<Map<string, { sessionId: string; turn: number; shared: boolean }[]>> {
    const out = new Map<string, { sessionId: string; turn: number; shared: boolean }[]>();
    const rows = this.ctx.db.prepare(`
      SELECT * FROM checkpoints WHERE cwd = ? AND at >= ? ORDER BY id DESC LIMIT 400
    `).all(cwd, since) as Row[];
    if (!rows.length) return out;
    // The newest undo or redo for a turn says whether its changes still stand.
    const verdict = new Map<string, CheckpointKind>();
    for (const r of rows) if (r.kind !== 'start' && r.event_id !== null && !verdict.has(`${r.session_id}:${r.event_id}`)) verdict.set(`${r.session_id}:${r.event_id}`, r.kind);
    const turns = rows.filter((r) => r.kind === 'turn' && r.commit_sha && r.before_sha && verdict.get(`${r.session_id}:${r.event_id}`) !== 'undo').slice(0, 80);
    if (!turns.length) return out;
    const top = await this.topOf(cwd);
    if (!top) return out;
    const env = await storeFor(top, this.objects);
    for (const r of turns) {
      const key = `${r.before_sha}..${r.commit_sha}`;
      let names = this.touchedCache.get(key);
      if (!names) {
        const text = await run(top, [...PLAIN_DIFF, '--name-only', '-z', r.before_sha as string, r.commit_sha as string], { env }).catch(() => null);
        if (text === null) continue;
        names = text.split('\0').filter(Boolean);
        if (this.touchedCache.size > 2_000) this.touchedCache.clear();
        this.touchedCache.set(key, names);
      }
      for (const path of names) {
        const list = out.get(path) ?? [];
        list.push({ sessionId: r.session_id, turn: r.turn, shared: r.shared === 1 });
        out.set(path, list);
      }
    }
    return out;
  }

  /* ── internals ────────────────────────────────────────────────────────── */

  private queue<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
    const result = (this.chains.get(sessionId) ?? Promise.resolve()).then(job);
    const tail = result.then(() => {}, () => {});
    this.chains.set(sessionId, tail);
    this.pending.add(tail);
    void tail.then(() => {
      this.pending.delete(tail);
      if (this.chains.get(sessionId) === tail) this.chains.delete(sessionId);
    });
    return result;
  }

  private async capture(sessionId: string, kind: 'start' | 'turn', eventId: number | null): Promise<void> {
    if (this.closed) return;
    const session = this.session(sessionId);
    const cwd = session.cwd ?? session.project_path;
    const before = this.rows(sessionId).findLast((r) => r.commit_sha !== null);
    const shot = await snapshot(cwd, this.tmp, this.timeoutMs, true, this.objects);
    if (this.closed) return;
    const turn = kind === 'start' || eventId === null ? 0 : (this.ctx.db.prepare(
      "SELECT count(*) AS n FROM session_events WHERE session_id = ? AND event = 'UserPromptSubmit' AND id <= ?",
    ).get(sessionId, eventId) as { n: number }).n;
    let counts: { files: number; additions: number; deletions: number } | null = null;
    if (!('reason' in shot) && shot.commit && before?.commit_sha) {
      const range = [before.commit_sha, shot.commit];
      const env = await storeFor(shot.top, this.objects);
      const [names, numstat] = await Promise.all([
        run(shot.top, [...PLAIN_DIFF, '--name-status', '-z', ...range], { env }),
        run(shot.top, [...PLAIN_DIFF, '--numstat', '-z', ...range], { env }),
      ]).catch(() => [null, null]);
      if (names !== null && numstat !== null) {
        const files = changedFiles(names, numstat);
        counts = { files: files.length, additions: files.reduce((n, f) => n + (f.additions ?? 0), 0), deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0) };
      }
    }
    if (this.closed) return;
    this.insert({
      session_id: sessionId, kind, turn, event_id: eventId, cwd,
      shared: kind === 'turn' && this.sharedSince(session, cwd, before?.at ?? session.started_at) ? 1 : 0,
      ...('reason' in shot
        ? { not_captured: shot.reason }
        : { commit_sha: shot.commit, tree_sha: shot.tree, head_sha: shot.head, before_sha: before?.commit_sha ?? null, ...counts }),
    });
    this.ctx.emit('sessions', { projectId: session.project_id, sessionId });
  }

  /**
   * Whether the last checkpoint can be undone (or redone) now: the rules, then
   * git still having both ends, then the folder matching it exactly. `commit`
   * keeps the folder's current state as a commit, for undo to start from.
   */
  private async assess(session: SessionFacts, rows: Row[], commit: boolean): Promise<{ refusal: string | null; now: Shot | null }> {
    const last = rows.at(-1) as Row;
    const previous = rows.at(-2);
    const beforeRow = last.kind === 'turn' ? rows.findLast((r) => r.commit_sha === last.before_sha && r.id < last.id) : undefined;
    const cwd = last.cwd;
    const others = (this.ctx.db.prepare(`SELECT title FROM sessions WHERE (cwd = ? OR substr(cwd, 1, length(?) + 1) = ? || '/') AND id != ? AND state IN (${LIVE_SQL})`)
      .all(cwd, cwd, cwd, session.id) as { title: string }[]).map((o) => o.title);
    const refusal = whyNotUndo({
      action: last.kind === 'undo' ? 'redo' : 'undo', turn: last.turn, notCaptured: last.not_captured,
      gapBefore: last.kind === 'turn' && (!previous || previous.commit_sha === null || !last.before_sha),
      committed: !!beforeRow && beforeRow.head_sha !== last.head_sha,
      files: last.files, state: session.state, provider: session.provider,
      worktree: cwd !== session.project_path && cwd.startsWith(`${this.worktrees}/`), folder: existsSync(cwd), others,
    });
    if (refusal) return { refusal, now: null };
    const name = turnName(last.turn);
    const since = last.kind === 'undo' ? 'you undid it' : last.kind === 'redo' ? 'you redid it' : `${name} ended`;
    const top = await this.topOf(cwd);
    const env = top ? await storeFor(top, this.objects) : {};
    if (!top || !(await has(top, last.commit_sha as string, env)) || !(await has(top, last.before_sha as string, env))) {
      return { refusal: `Git no longer has ${name}’s checkpoint, so it cannot be put back.`, now: null };
    }
    const loses = await deletesWhatWasThere(top, env, last, rows);
    if (loses) return { refusal: loses, now: null };
    // Availability needs only the tree identity. Its copied real index reads
    // repository objects; persistent checkpoint objects were checked above.
    // Keep assessment-only writes private and short-lived, without pruning any
    // captured evidence. A committed undo/redo snapshot must remain available.
    const temporary = commit ? null : await mkdtemp(join(this.tmp, 'assessment-'));
    try {
      const now = await snapshot(cwd, this.tmp, this.timeoutMs, commit, temporary ?? this.objects);
      if ('reason' in now) return { refusal: `Wanigan could not check the folder: ${now.reason}.`, now: null };
      if (now.head !== last.head_sha) return { refusal: `A commit was made since ${since}.`, now };
      if (now.tree !== last.tree_sha) return { refusal: `The folder has changed since ${since}, so this could lose that work.`, now };
      return { refusal: null, now };
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }

  /** Another session was live in this folder at some point since `from`. */
  private sharedSince(session: SessionFacts, cwd: string, from: number): boolean {
    const now = this.ctx.now();
    return !!this.ctx.db.prepare(`
      SELECT 1 FROM sessions WHERE (cwd = ? OR substr(cwd, 1, length(?) + 1) = ? || '/') AND id != ? AND started_at <= ?
        AND (state IN (${LIVE_SQL}) OR coalesce(ended_at, started_at) >= ?) LIMIT 1
    `).get(cwd, cwd, cwd, session.id, now, from);
  }

  private async topOf(cwd: string): Promise<string | null> {
    if (!existsSync(cwd)) return null;
    return run(cwd, ['rev-parse', '--show-toplevel']).then((s) => s.trim() || null, () => null);
  }

  private insert(row: Partial<Row> & Pick<Row, 'session_id' | 'kind' | 'turn' | 'cwd'>): void {
    this.ctx.db.prepare(`INSERT INTO checkpoints (session_id, kind, turn, event_id, cwd, commit_sha, tree_sha, head_sha, before_sha, not_captured, shared, files, additions, deletions, at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.session_id, row.kind, row.turn, row.event_id ?? null, row.cwd, row.commit_sha ?? null, row.tree_sha ?? null, row.head_sha ?? null,
        row.before_sha ?? null, row.not_captured ?? null, row.shared ?? 0, row.files ?? null, row.additions ?? null, row.deletions ?? null, this.ctx.now());
  }

  private rows(sessionId: string): Row[] {
    return this.ctx.db.prepare('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY id').all(sessionId) as Row[];
  }

  private session(id: string): SessionFacts {
    const row = this.ctx.db.prepare(`
      SELECT s.id, s.project_id, s.card_id, s.provider, s.state, s.title, s.cwd, s.started_at, p.path AS project_path
      FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?
    `).get(id) as SessionFacts | undefined;
    if (!row) throw new CoreError('not_found', 'No such session.');
    return row;
  }
}

const toCheckpoint = (r: Row): Checkpoint => ({
  id: r.id, sessionId: r.session_id, kind: r.kind, turn: r.turn, eventId: r.event_id, at: r.at,
  notCaptured: r.not_captured, files: r.files, additions: r.additions, deletions: r.deletions, shared: r.shared === 1,
});

/**
 * The folder as git sees it, read through a temporary copy of its index so the
 * real one is never written. Bounded by `deadline`; anything that stops it
 * comes back as a reason, never as an error.
 */
export async function snapshot(cwd: string, tmp: string, limitMs: number, commit: boolean, objects?: string): Promise<Shot | { reason: string }> {
  if (!existsSync(cwd)) return { reason: 'the folder is gone' };
  const opts = { deadline: Date.now() + limitMs };
  const tooLong = `it took longer than ${limitMs >= 1000 ? `${Math.round(limitMs / 1000)} seconds` : `${limitMs} ms`}`;
  let top: string;
  try {
    top = (await run(cwd, ['rev-parse', '--show-toplevel'], opts)).trim();
  } catch (error) {
    const e = error as { code?: string; stderr?: string };
    // Without the Xcode command line tools, /usr/bin/git is a stub that only says so.
    return { reason: timedOut(error) ? tooLong : gitMissing(e, e.stderr ?? '') ? 'git is not installed' : 'not a git repository' };
  }
  if (!top) return { reason: 'not a git repository' };
  const temp = join(tmp, `${randomUUID()}.index`);
  try {
    const [index, head] = await Promise.all([
      run(cwd, ['rev-parse', '--git-path', 'index'], opts).then((s) => resolve(cwd, s.trim())),
      run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], opts).then((s) => s.trim() || null, () => null),
    ]);
    // Starting from the real index keeps it fast: only what changed is hashed.
    // The copy keeps the index's own time, down to the second: git trusts a
    // file's size and times only when they are older than the index, so a copy
    // stamped later would take a same-size edit made in the second the index was
    // written for unchanged, where git itself would look at it.
    const gone = (error: NodeJS.ErrnoException): null => { if (error.code === 'ENOENT') return null; throw error; };
    const real = await stat(index).catch(gone);
    if (real && await copyFile(index, temp).then(() => true, gone)) await utimes(temp, real.atime, Math.floor(real.mtimeMs / 1000));
    const store = objects ? await storeFor(top, objects) : {};
    const env = { GIT_INDEX_FILE: temp, ...store };
    // Large untracked files are named and left out, so a checkpoint never copies a database or a build.
    const untracked = (await run(top, ['ls-files', '--others', '--exclude-standard', '-z'], { ...opts, env })).split('\0').filter(Boolean);
    const large: string[] = [];
    for (const path of untracked) {
      if ((await stat(join(top, path)).then((st) => st.size, () => 0)) > MAX_UNTRACKED_BYTES) large.push(path);
      if (large.length > MAX_LEFT_OUT) return { reason: `more than ${MAX_LEFT_OUT} untracked files are over ${MAX_UNTRACKED_BYTES / 1024 / 1024} MB` };
    }
    // Written whole: a split index would write its shared part beside the real one.
    await run(top, ['-c', 'core.splitIndex=false', 'add', '--all', '--', '.', ...large.map((p) => `:(exclude,top,literal)${p}`)], { ...opts, env });
    const tree = (await run(top, ['write-tree'], { ...opts, env })).trim();
    const sha = commit
      ? (await run(top, ['commit-tree', '--no-gpg-sign', ...(head ? ['-p', head] : []), '-m', 'wanigan checkpoint', tree], { ...opts, env: { ...IDENTITY, ...store } })).trim()
      : null;
    return { tree, commit: sha, head, top };
  } catch (error) {
    return { reason: timedOut(error) ? tooLong : `git could not read the folder (${firstLine(error as Error)})` };
  } finally {
    await Promise.all([rm(temp, { force: true }), rm(`${temp}.lock`, { force: true })]);
  }
}

/** Git, with nothing from the core's own environment pointing it elsewhere. */
function run(cwd: string, args: string[], options: { deadline?: number; env?: Record<string, string>; input?: string } = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...options.env };
  for (const key of GIT_REDIRECTS) if (!options.env?.[key]) delete env[key];
  const timeout = options.deadline === undefined ? 30_000 : options.deadline - Date.now();
  if (timeout <= 0) return Promise.reject(Object.assign(new Error('timed out'), { killed: true }));
  return new Promise((resolvePromise, reject) => {
    const child = execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, env, timeout, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr ?? '') })) : resolvePromise(String(stdout))));
    // A git that exits before reading all its input must not take the core down with it.
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input ?? '');
  });
}

/**
 * Why going back would delete a file that was there before the turn, or null.
 * Git saw only what .gitignore (and .git/info/exclude) let it see, so a file
 * that was always there can look new to it: deleting that would lose it for
 * good. A turn that changed .gitignore is refused outright; otherwise a file is
 * kept if it was created before the turn's starting checkpoint.
 */
async function deletesWhatWasThere(top: string, env: Record<string, string>, last: Row, rows: Row[]): Promise<string | null> {
  if (!last.commit_sha || !last.before_sha) return null;
  let diff: string;
  try {
    diff = await run(top, [...PLAIN_DIFF, '--name-status', '-z', last.commit_sha, last.before_sha], { env });
  } catch (error) {
    return `Wanigan could not check which files going back would delete: ${firstLine(error as Error)}.`;
  }
  const changed = changedFiles(diff, '');
  const deletes = changed.filter((c) => c.status === 'D');
  if (!deletes.length) return null;
  const name = turnName(last.turn);
  if (changed.some((c) => c.path === '.gitignore' || c.path.endsWith('/.gitignore'))) {
    return `${capitalise(name)} changed .gitignore, so git cannot tell whether the files going back would delete were there before it. Undo it by hand.`;
  }
  const since = rows.find((r) => r.commit_sha === last.before_sha && r.id < last.id)?.at ?? null;
  if (since === null) return null;
  for (const f of deletes) {
    const born = await stat(join(top, f.path)).then((st) => st.birthtimeMs, () => 0);
    if (born > 0 && born < since) return `Going back would delete ${f.path}, which was there before ${name} (git could not see it then).`;
  }
  return null;
}

/** Whether git still has a commit. */
const has = (top: string, sha: string, env: Record<string, string>): Promise<boolean> =>
  run(top, ['cat-file', '-e', `${sha}^{commit}`], { env }).then(() => true, () => false);

/**
 * Where a repository's checkpoint objects go: Wanigan's own store for it, under
 * the data dir, keyed by the repository's real common git dir (so worktrees of
 * one repository share it), reading the repository's objects as an alternate.
 */
async function storeFor(top: string, objects: string): Promise<Record<string, string>> {
  const common = resolve(top, (await run(top, ['rev-parse', '--git-common-dir'])).trim());
  let real = common;
  try { real = realpathSync(common); } catch { /* use it as given */ }
  const dir = join(objects, createHash('sha256').update(real).digest('hex').slice(0, 16));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { GIT_OBJECT_DIRECTORY: dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(real, 'objects') };
}

const timedOut = (error: unknown): boolean => (error as { killed?: boolean })?.killed === true;

function firstLine(error: Error): string {
  const text = ((error as { stderr?: string }).stderr || error.message).trim();
  return text.split('\n').find((l) => l.trim())?.replace(/^(error|fatal): /, '') ?? 'unknown error';
}
