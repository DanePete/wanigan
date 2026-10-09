// Projects, cards and everything on a card. Every rule in src/shared/board.ts is
// enforced here; the UI only decides what to offer.
import { phoneActorNow } from './phone/context.ts';
import { readBriefing, type BriefingFormat, type BriefingLimits } from './briefing.ts';
import { localModelLabel, parseLocalModel } from '../shared/local-models.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  LEASE_MS, RANK_EPSILON, cardKey, checkClaim, checkOwnerMove, checkSubmit, isValidProjectKey, projectKeyFrom, rankBetween,
} from '../shared/board.ts';
import {
  CARD_TYPES, COLUMNS, EVIDENCE_KINDS, OWNER, PRIORITIES, SYSTEM, actorSessionId, sessionActor,
  type Activity, type Actor, type CardDetail, type CardStatus, type CardSummary, type CardType, type Decision,
  type AccountProvider, type Priority, type Project, type ProjectSummary, type Provider, type SessionState,
} from '../shared/model.ts';
import { JEV_MODES, type JevMode, type JevRead } from '../shared/jev.ts';
import { CoreError, type EvidenceInput } from '../shared/protocol.ts';
import type { Ctx } from './context.ts';
import {
  LIVE_SQL, SESSION_COLUMNS, toActivity, toAiReview, toCard, toComment, toCriterion, toDecision, toEvidence, toProject, toSession,
  type ActivityRow, type AiReviewRow, type CardRow, type CommentRow, type CriterionRow, type DecisionRow, type EvidenceRow,
  type ProjectRow, type SessionRow,
} from './records.ts';

const MAX_TITLE = 200;
const MAX_COMMAND = 500;
const MAX_TEXT = 20_000;

/** Jev's actor name in the activity log. */
export const JEV = 'jev';

function reviewMark(state: string, resultJson: string | null): CardSummary['aiReview'] {
  if (state === 'running' || state === 'failed') return state;
  try {
    const verdict = (JSON.parse(resultJson ?? 'null') as { verdict?: string } | null)?.verdict;
    return verdict === 'pass' || verdict === 'changes' || verdict === 'unsure' ? verdict : null;
  } catch {
    return null;
  }
}

function parseRead(json: string): JevRead | null {
  try { return JSON.parse(json) as JevRead; } catch { return null; }
}

export class Board {
  private readonly ctx: Ctx;
  /** Told about every new card, by anyone. Jev listens here. */
  readonly created = new Set<(card: CardSummary) => void>();

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  /* ── projects ─────────────────────────────────────────────────────────── */

  listProjects(needsByProject: ReadonlyMap<string, number>): ProjectSummary[] {
    const { db } = this.ctx;
    const rows = db.prepare('SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE').all() as ProjectRow[];
    const counts = db.prepare(
      "SELECT project_id, status, count(*) AS n FROM cards WHERE status != 'archived' GROUP BY project_id, status",
    ).all() as { project_id: string; status: CardStatus; n: number }[];
    const live = db.prepare(
      `SELECT project_id, count(*) AS n FROM sessions WHERE state IN (${LIVE_SQL}) GROUP BY project_id`,
    ).all() as { project_id: string; n: number }[];
    const chosen = db.prepare('SELECT project_id, provider, account_id FROM project_accounts').all() as
      { project_id: string; provider: AccountProvider; account_id: string }[];
    return rows.map((row) => {
      const c = Object.fromEntries(COLUMNS.map((s) => [s, 0])) as ProjectSummary['counts'];
      for (const r of counts) if (r.project_id === row.id && r.status !== 'archived') c[r.status] = r.n;
      return {
        ...toProject(row),
        counts: c,
        liveSessions: live.find((l) => l.project_id === row.id)?.n ?? 0,
        needsYou: needsByProject.get(row.id) ?? 0,
        pathOk: isDirectory(row.path),
        pausedAt: row.paused_at,
        git: existsSync(join(row.path, '.git')),
        isolate: row.isolate === 1,
        setupCommand: row.setup_command,
        jev: (JEV_MODES as readonly string[]).includes(row.jev) ? row.jev as JevMode : 'read',
        localModel: row.local_model,
        accounts: Object.fromEntries(chosen.filter((a) => a.project_id === row.id).map((a) => [a.provider, a.account_id])),
      };
    });
  }

  project(id: string): Project {
    const row = this.ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) throw new CoreError('not_found', 'No such project.');
    return toProject(row);
  }

  addProject(params: { path: string; name?: string; key?: string }): Project {
    const { db } = this.ctx;
    // ~/Projects/shop is how people write a folder; it means the same as the full path.
    const given = params.path.trim();
    const full = given === '~' ? homedir() : given.startsWith('~/') ? join(homedir(), given.slice(2)) : given;
    if (!isAbsolute(full)) throw new CoreError('invalid', 'Give the full path to the project folder, or one that starts with ~/.');
    if (!isDirectory(full)) throw new CoreError('invalid', `There is no folder at ${given}.`);
    const path = realpathSync(full);
    const existing = db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as ProjectRow | undefined;
    if (existing) {
      if (existing.archived_at !== null) db.prepare('UPDATE projects SET archived_at = NULL WHERE id = ?').run(existing.id);
      this.ctx.emit('projects', {});
      return this.project(existing.id);
    }
    const name = text(params.name ?? basename(path), 'name', 80);
    const taken = new Set((db.prepare('SELECT key FROM projects').all() as { key: string }[]).map((r) => r.key));
    const key = params.key ? params.key.toUpperCase() : projectKeyFrom(name, taken);
    if (!isValidProjectKey(key)) throw new CoreError('invalid', 'A project key is 1–6 letters or digits, starting with a letter.');
    if (taken.has(key)) throw new CoreError('conflict', `The key ${key} is already used by another project.`);
    const id = randomUUID();
    db.prepare('INSERT INTO projects (id, key, name, path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, key, name, path, this.ctx.now());
    this.log({ projectId: id, actor: OWNER, verb: 'opened the project', detail: path });
    this.ctx.emit('projects', {});
    return this.project(id);
  }

  updateProject(params: { id: string; name?: string; key?: string; isolate?: boolean; jev?: JevMode; setupCommand?: string | null; localModel?: string | null }): Project {
    const { db } = this.ctx;
    const project = this.project(params.id);
    db.transaction(() => {
      if (params.jev !== undefined) {
        if (!JEV_MODES.includes(params.jev)) throw new CoreError('invalid', `Jev is one of ${JEV_MODES.join(', ')}.`);
        db.prepare('UPDATE projects SET jev = ? WHERE id = ?').run(params.jev, project.id);
        const verb = { off: 'turned Jev off', read: 'let Jev read new cards', accept: 'let Jev read new cards and accept confident ones' }[params.jev];
        this.log({ projectId: project.id, actor: OWNER, verb });
      }
      if (params.isolate !== undefined) {
        db.prepare('UPDATE projects SET isolate = ? WHERE id = ?').run(params.isolate ? 1 : 0, project.id);
        this.log({ projectId: project.id, actor: OWNER, verb: params.isolate ? 'gave card sessions their own branches' : 'let card sessions share the project folder' });
      }
      if (params.localModel !== undefined) {
        const local = params.localModel === null ? null : parseLocalModel(params.localModel);
        if (params.localModel !== null && !local) throw new CoreError('invalid', 'That is not a local model.');
        db.prepare('UPDATE projects SET local_model = ? WHERE id = ?').run(params.localModel, project.id);
        this.log({ projectId: project.id, actor: OWNER, verb: local ? 'set new sessions to start on a local model' : 'set new sessions to start on the agent’s own model', detail: local ? localModelLabel(params.localModel as string) : null });
      }
      if (params.setupCommand !== undefined) {
        const command = params.setupCommand === null ? '' : text(params.setupCommand, 'setup command', MAX_COMMAND, true);
        // One line the owner's shell runs; a newline would hide a second command from the settings field.
        if (/[\x00-\x1f\x7f]/.test(command)) throw new CoreError('invalid', 'The setup command is one line.');
        db.prepare('UPDATE projects SET setup_command = ? WHERE id = ?').run(command || null, project.id);
        this.log({ projectId: project.id, actor: OWNER, verb: command ? 'set the worktree setup command' : 'cleared the worktree setup command', detail: command || null });
      }
      if (params.name !== undefined) {
        db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(text(params.name, 'name', 80), project.id);
      }
      if (params.key !== undefined && params.key.toUpperCase() !== project.key) {
        const key = params.key.toUpperCase();
        if (!isValidProjectKey(key)) throw new CoreError('invalid', 'A project key is 1–6 letters or digits, starting with a letter.');
        const used = db.prepare('SELECT 1 FROM projects WHERE key = ? AND id != ?').get(key, project.id);
        if (used) throw new CoreError('conflict', `The key ${key} is already used by another project.`);
        db.transaction(() => {
          db.prepare('UPDATE projects SET key = ? WHERE id = ?').run(key, project.id);
          db.prepare("UPDATE cards SET key = ? || '-' || seq WHERE project_id = ?").run(key, project.id);
        })();
        this.log({ projectId: project.id, actor: OWNER, verb: 'changed the project key', detail: `${project.key} → ${key}` });
      }
    })();
    this.ctx.emit('projects', {});
    this.ctx.emit('board', { projectId: project.id, cardId: null });
    return this.project(project.id);
  }

  /** Whether card sessions in a project get their own worktree by default. */
  jevMode(projectId: string): JevMode {
    const row = this.ctx.db.prepare('SELECT jev FROM projects WHERE id = ?').get(projectId) as { jev: string } | undefined;
    return row && (JEV_MODES as readonly string[]).includes(row.jev) ? row.jev as JevMode : 'off';
  }

  /** Jev's Accept mode: a confident "ready" moves an Inbox card to Ready, and says so. */
  acceptByJev(cardId: string, why: string): void {
    const card = toCard(this.row(cardId));
    if (card.status !== 'inbox') return;
    const top = this.ctx.db.prepare("SELECT min(rank) AS r FROM cards WHERE project_id = ? AND status = 'ready'").get(card.projectId) as { r: number | null };
    this.ctx.db.prepare("UPDATE cards SET status = 'ready', rank = ?, updated_at = ? WHERE id = ?").run(rankBetween(null, top.r), this.ctx.now(), card.id);
    this.log({ projectId: card.projectId, cardId: card.id, actor: JEV, verb: 'accepted it to Ready', detail: why });
    this.changed(card.projectId, card.id);
  }

  /** What runs in each new card worktree of a project, if anything. */
  setupCommand(projectId: string): string | null {
    return (this.ctx.db.prepare('SELECT setup_command FROM projects WHERE id = ?').get(projectId) as { setup_command: string | null } | undefined)?.setup_command ?? null;
  }

  isolates(projectId: string): boolean {
    return (this.ctx.db.prepare('SELECT isolate FROM projects WHERE id = ?').get(projectId) as { isolate: number } | undefined)?.isolate === 1;
  }

  setWorktree(cardId: string, worktree: { path: string; branch: string; base: string } | null): void {
    const card = this.row(cardId);
    this.ctx.db.prepare('UPDATE cards SET worktree_path = ?, worktree_branch = ?, worktree_base = ?, updated_at = ? WHERE id = ?')
      .run(worktree?.path ?? null, worktree?.branch ?? null, worktree?.base ?? null, this.ctx.now(), card.id);
    this.log({
      projectId: card.project_id, cardId: card.id, actor: OWNER,
      verb: worktree ? 'gave the card its own branch' : 'removed the card’s branch', detail: worktree?.branch ?? card.worktree_branch,
    });
    this.changed(card.project_id, card.id);
  }

  /** The pull request opened for a card's branch. */
  setPullRequest(cardId: string, url: string): void {
    const card = this.row(cardId);
    this.ctx.db.prepare('UPDATE cards SET pr_url = ?, updated_at = ? WHERE id = ?').run(url, this.ctx.now(), card.id);
    this.log({ projectId: card.project_id, cardId: card.id, actor: OWNER, verb: `pushed ${card.worktree_branch ?? 'its branch'} and opened a pull request`, detail: url });
    this.changed(card.project_id, card.id);
  }

  /** Whether new work is blocked in a project, and since when. */
  pausedAt(projectId: string): number | null {
    const r = this.ctx.db.prepare('SELECT paused_at FROM projects WHERE id = ?').get(projectId) as { paused_at: number | null } | undefined;
    if (!r) throw new CoreError('not_found', 'No such project.');
    return r.paused_at;
  }

  pause(id: string): Project {
    const project = this.project(id);
    if (this.pausedAt(id) !== null) return project;
    this.ctx.db.prepare('UPDATE projects SET paused_at = ?, paused_by = ? WHERE id = ?').run(this.ctx.now(), OWNER, id);
    this.log({ projectId: id, actor: OWNER, verb: 'paused the project', detail: 'New sessions and claims are blocked' });
    this.ctx.emit('projects', {});
    this.ctx.emit('board', { projectId: id, cardId: null });
    return project;
  }

  resume(id: string): Project {
    const project = this.project(id);
    if (this.pausedAt(id) === null) return project;
    this.ctx.db.prepare('UPDATE projects SET paused_at = NULL, paused_by = NULL WHERE id = ?').run(id);
    this.log({ projectId: id, actor: OWNER, verb: 'resumed the project' });
    this.ctx.emit('projects', {});
    this.ctx.emit('board', { projectId: id, cardId: null });
    return project;
  }

  archiveProject(id: string): void {
    const project = this.project(id);
    const live = this.ctx.db.prepare(
      `SELECT count(*) AS n FROM sessions WHERE project_id = ? AND state IN (${LIVE_SQL})`,
    ).get(id) as { n: number };
    if (live.n > 0) throw new CoreError('refused', 'Stop this project’s live sessions before closing it.');
    this.ctx.db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(this.ctx.now(), project.id);
    this.log({ projectId: id, actor: OWNER, verb: 'closed the project' });
    this.ctx.emit('projects', {});
  }

  /* ── cards: reading ───────────────────────────────────────────────────── */

  listCards(projectId: string): CardSummary[] {
    this.project(projectId);
    const rows = this.ctx.db.prepare(
      "SELECT * FROM cards WHERE project_id = ? AND status != 'archived' ORDER BY status, rank, created_at",
    ).all(projectId) as CardRow[];
    return this.summarise(rows);
  }

  /** Cards in every open project whose key, title or description matches. Newest first. */
  search(query: string, limit = 30): (CardSummary & { projectKey: string })[] {
    const q = query.trim();
    if (!q) return [];
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.ctx.db.prepare(`
      SELECT c.* FROM cards c JOIN projects p ON p.id = c.project_id AND p.archived_at IS NULL
      WHERE c.status != 'archived' AND (c.key LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\' OR c.body LIKE ? ESCAPE '\\')
      ORDER BY (c.key LIKE ? ESCAPE '\\') DESC, (c.title LIKE ? ESCAPE '\\') DESC, c.updated_at DESC LIMIT ?
    `).all(like, like, like, like, like, Math.min(limit, 100)) as CardRow[];
    const keys = new Map((this.ctx.db.prepare('SELECT id, key FROM projects').all() as { id: string; key: string }[]).map((r) => [r.id, r.key]));
    return this.summarise(rows).map((c) => ({ ...c, projectKey: keys.get(c.projectId) ?? '' }));
  }

  card(id: string): CardSummary {
    const row = this.row(id);
    return this.summarise([row])[0] as CardSummary;
  }

  /** Complete, admitted session instructions without loading unrelated card history. */
  briefing(projectId: string, cardId: string | null, limits: Readonly<BriefingLimits>, format: BriefingFormat): string {
    return readBriefing(this.ctx.db, projectId, cardId, limits, format);
  }

  /** One card in full. `idOrKey` may be the card's id or its key (NS-12). */
  detail(idOrKey: string): CardDetail {
    const { db } = this.ctx;
    const card = this.card(idOrKey);
    const id = card.id;
    return {
      ...card,
      criteria: (db.prepare('SELECT * FROM criteria WHERE card_id = ? ORDER BY position').all(id) as CriterionRow[]).map(toCriterion),
      comments: (db.prepare('SELECT * FROM comments WHERE card_id = ? ORDER BY created_at').all(id) as CommentRow[]).map(toComment),
      evidence: (db.prepare('SELECT * FROM evidence WHERE card_id = ? ORDER BY created_at').all(id) as EvidenceRow[]).map(toEvidence),
      sessions: (db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE card_id = ? ORDER BY started_at DESC`).all(id) as SessionRow[]).map(toSession),
      activity: (db.prepare('SELECT * FROM activity WHERE card_id = ? ORDER BY id DESC LIMIT 100').all(id) as ActivityRow[]).map(toActivity),
      reviews: (db.prepare('SELECT * FROM ai_reviews WHERE card_id = ? ORDER BY started_at DESC LIMIT 5').all(id) as AiReviewRow[]).map(toAiReview),
    };
  }

  /* ── cards: owner and agent operations ────────────────────────────────── */

  createCard(actor: Actor, params: {
    projectId: string; type: CardType; title: string; body?: string; priority?: Priority; status?: 'inbox' | 'ready';
  }): CardSummary {
    const { db } = this.ctx;
    const project = this.project(params.projectId);
    if (!CARD_TYPES.includes(params.type)) throw new CoreError('invalid', `Type must be one of ${CARD_TYPES.join(', ')}.`);
    const priority = params.priority ?? 2;
    if (!PRIORITIES.includes(priority)) throw new CoreError('invalid', 'Priority is 0 (most urgent) to 3.');
    // What an agent files lands in the Inbox for the owner to accept.
    const status: CardStatus = actor === OWNER ? (params.status ?? 'ready') : 'inbox';
    const title = text(params.title, 'title', MAX_TITLE);
    const body = params.body === undefined ? '' : text(params.body, 'description', MAX_TEXT, true);
    const id = randomUUID();
    const now = this.ctx.now();
    db.transaction(() => {
      const { next_seq: seq } = db.prepare('SELECT next_seq FROM projects WHERE id = ?').get(project.id) as { next_seq: number };
      db.prepare('UPDATE projects SET next_seq = next_seq + 1 WHERE id = ?').run(project.id);
      const top = db.prepare('SELECT min(rank) AS r FROM cards WHERE project_id = ? AND status = ?').get(project.id, status) as { r: number | null };
      db.prepare(`INSERT INTO cards (id, project_id, seq, key, type, title, body, status, priority, rank, created_by, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, project.id, seq, cardKey(project.key, seq), params.type, title, body, status, priority,
          rankBetween(null, top.r), actor, now, now);
    })();
    this.log({ projectId: project.id, cardId: id, actor, verb: 'created', detail: title });
    this.changed(project.id, id);
    const card = this.card(id);
    for (const listener of this.created) listener(card);
    return card;
  }

  updateCard(params: { id: string; title?: string; body?: string; type?: CardType; priority?: Priority }): CardSummary {
    const card = this.row(params.id);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (params.title !== undefined) { sets.push('title = ?'); values.push(text(params.title, 'title', MAX_TITLE)); }
    if (params.body !== undefined) { sets.push('body = ?'); values.push(text(params.body, 'description', MAX_TEXT, true)); }
    if (params.type !== undefined) {
      if (!CARD_TYPES.includes(params.type)) throw new CoreError('invalid', `Type must be one of ${CARD_TYPES.join(', ')}.`);
      sets.push('type = ?'); values.push(params.type);
    }
    if (params.priority !== undefined) {
      if (!PRIORITIES.includes(params.priority)) throw new CoreError('invalid', 'Priority is 0 (most urgent) to 3.');
      sets.push('priority = ?'); values.push(params.priority);
    }
    if (!sets.length) return this.card(card.id);
    sets.push('updated_at = ?'); values.push(this.ctx.now());
    this.ctx.db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...values, card.id);
    const what = [params.title !== undefined && 'title', params.body !== undefined && 'description',
      params.type !== undefined && `type → ${params.type}`, params.priority !== undefined && `priority → P${params.priority}`]
      .filter(Boolean).join(', ');
    this.log({ projectId: card.project_id, cardId: card.id, actor: OWNER, verb: 'edited', detail: what });
    this.changed(card.project_id, card.id);
    return this.card(card.id);
  }

  /** The owner drags a card. Leaving Working takes the card back from its session. */
  moveCard(params: { id: string; status: CardStatus; before?: string | null; after?: string | null }): CardSummary {
    const { db } = this.ctx;
    const card = toCard(this.row(params.id));
    if (!(COLUMNS as readonly string[]).includes(params.status) && params.status !== 'archived') {
      throw new CoreError('invalid', 'No such column.');
    }
    const evidence = (db.prepare('SELECT count(*) AS n FROM evidence WHERE card_id = ?').get(card.id) as { n: number }).n;
    const refusal = checkOwnerMove(card, params.status, evidence);
    if (refusal) throw new CoreError('refused', refusal.message);
    const rankOf = (id: string | null | undefined): number | null => {
      if (!id) return null;
      const r = db.prepare('SELECT rank FROM cards WHERE id = ? AND project_id = ?').get(id, card.projectId) as { rank: number } | undefined;
      return r ? r.rank : null;
    };
    let before = rankOf(params.before);
    let after = rankOf(params.after);
    if (before !== null && after !== null && Math.abs(after - before) < RANK_EPSILON) {
      // Halving a gap again and again runs out of float: space the column out.
      this.renumber(card.projectId, params.status);
      before = rankOf(params.before);
      after = rankOf(params.after);
    }
    const rank = rankBetween(before, after);
    const statusChanged = params.status !== card.status;
    db.transaction(() => {
      db.prepare('UPDATE cards SET status = ?, rank = ?, updated_at = ? WHERE id = ?').run(params.status, rank, this.ctx.now(), card.id);
      if (statusChanged && card.claim) {
        db.prepare('UPDATE cards SET claim_session = NULL, claim_expires = NULL, claim_note = NULL WHERE id = ?').run(card.id);
      }
      if (statusChanged && params.status === 'done') db.prepare('UPDATE cards SET sent_back = 0, reopened = 0 WHERE id = ?').run(card.id);
    })();
    if (statusChanged) {
      const took = card.claim ? ` (took it back from ${sessionActor(card.claim.sessionId)})` : '';
      this.log({ projectId: card.projectId, cardId: card.id, actor: OWNER, verb: `moved to ${params.status}`, detail: `from ${card.status}${took}` });
    }
    this.changed(card.projectId, card.id);
    return this.card(card.id);
  }

  private renumber(projectId: string, status: CardStatus): void {
    const { db } = this.ctx;
    const ids = db.prepare('SELECT id FROM cards WHERE project_id = ? AND status = ? ORDER BY rank, priority, created_at')
      .all(projectId, status) as { id: string }[];
    const set = db.prepare('UPDATE cards SET rank = ? WHERE id = ?');
    db.transaction(() => ids.forEach((r, i) => set.run((i + 1) * 1_000, r.id)))();
  }

  comment(actor: Actor, cardId: string, body: string, kind: 'comment' | 'question' = 'comment'): void {
    const card = this.row(cardId);
    const now = this.ctx.now();
    this.ctx.db.prepare('INSERT INTO comments (id, card_id, author, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), card.id, actor, text(body, 'comment', MAX_TEXT), kind, now);
    if (actor === OWNER) {
      // The owner replying settles any open question on the card.
      this.ctx.db.prepare("UPDATE comments SET resolved_at = ? WHERE card_id = ? AND kind = 'question' AND resolved_at IS NULL").run(now, card.id);
    }
    this.log({ projectId: card.project_id, cardId: card.id, actor, verb: kind === 'question' ? 'asked' : 'commented', detail: clip(body) });
    this.changed(card.project_id, card.id, true);
  }

  claim(sessionId: string, cardId: string, note?: string, byOwner = false): CardSummary {
    if (note !== undefined) note = text(note, 'note', MAX_TEXT, true);
    const { db } = this.ctx;
    const card = toCard(this.row(cardId));
    this.assertSameProject(sessionId, card.projectId);
    if (this.pausedAt(card.projectId) !== null && card.claim?.sessionId !== sessionId) {
      throw new CoreError('refused', 'The owner has paused this project. Note where you are on your card (`wanigan note`) and stop.');
    }
    const now = this.ctx.now();
    const refusal = checkClaim(card, sessionId, now, byOwner);
    if (refusal) throw new CoreError('refused', refusal.message);
    db.transaction(() => {
      db.prepare(`UPDATE cards SET status = 'working', claim_session = ?, claim_expires = ?, claim_note = ?, updated_at = ? WHERE id = ?`)
        .run(sessionId, now + LEASE_MS, note ?? null, now, card.id);
      db.prepare('UPDATE sessions SET card_id = ? WHERE id = ? AND card_id IS NULL').run(card.id, sessionId);
    })();
    if (card.claim?.sessionId !== sessionId) {
      this.log({ projectId: card.projectId, cardId: card.id, sessionId, actor: sessionActor(sessionId), verb: 'claimed', detail: note ?? null });
    }
    if (note) this.comment(sessionActor(sessionId), card.id, note);
    this.changed(card.projectId, card.id, true);
    this.ctx.emit('sessions', { projectId: card.projectId, sessionId });
    return this.card(card.id);
  }

  heartbeat(sessionId: string, cardId: string, note?: string): CardSummary {
    if (note !== undefined) note = text(note, 'note', MAX_TEXT, true);
    const card = toCard(this.row(cardId));
    this.assertHolds(sessionId, card);
    this.ctx.db.prepare('UPDATE cards SET claim_expires = ?, claim_note = coalesce(?, claim_note) WHERE id = ?')
      .run(this.ctx.now() + LEASE_MS, note ?? null, card.id);
    if (note) this.comment(sessionActor(sessionId), card.id, note);
    else this.changed(card.projectId, card.id);
    return this.card(card.id);
  }

  release(actor: Actor, cardId: string, note?: string): CardSummary {
    if (note !== undefined) note = text(note, 'note', MAX_TEXT, true);
    const card = toCard(this.row(cardId));
    const sessionId = actorSessionId(actor);
    if (sessionId) this.assertHolds(sessionId, card);
    else if (!card.claim) throw new CoreError('refused', 'Nobody holds this card.');
    this.ctx.db.prepare(`UPDATE cards SET status = 'ready', claim_session = NULL, claim_expires = NULL, claim_note = NULL, updated_at = ? WHERE id = ?`)
      .run(this.ctx.now(), card.id);
    this.log({ projectId: card.projectId, cardId: card.id, sessionId: card.claim?.sessionId ?? null, actor, verb: 'released', detail: note ?? null });
    if (note) this.comment(actor, card.id, note);
    this.changed(card.projectId, card.id, true);
    return this.card(card.id);
  }

  submit(sessionId: string, cardId: string, evidence: EvidenceInput[], note?: string): CardSummary {
    if (note !== undefined) note = text(note, 'note', MAX_TEXT, true);
    const { db } = this.ctx;
    const card = toCard(this.row(cardId));
    this.assertSameProject(sessionId, card.projectId);
    const project = this.project(card.projectId);
    const offered = evidence.map((e) => this.validEvidence(e, project.path));
    const existing = (db.prepare('SELECT count(*) AS n FROM evidence WHERE card_id = ?').get(card.id) as { n: number }).n;
    const refusal = checkSubmit(card, sessionId, existing + offered.length, this.ctx.now());
    if (refusal) throw new CoreError('refused', refusal.message);
    const actor = sessionActor(sessionId);
    db.transaction(() => {
      for (const e of offered) this.insertEvidence(card.id, actor, e);
      db.prepare(`UPDATE cards SET status = 'review', sent_back = 0, claim_session = NULL, claim_expires = NULL, claim_note = NULL, updated_at = ? WHERE id = ?`)
        .run(this.ctx.now(), card.id);
    })();
    this.log({ projectId: card.projectId, cardId: card.id, sessionId, actor, verb: 'submitted for review', detail: note ?? `${offered.length} evidence` });
    if (note) this.comment(actor, card.id, note);
    this.changed(card.projectId, card.id, true);
    return this.card(card.id);
  }

  approve(cardId: string, note?: string): CardSummary {
    if (note !== undefined) note = text(note, 'note', MAX_TEXT, true);
    const card = toCard(this.row(cardId));
    if (card.status !== 'review') throw new CoreError('refused', `Only a card in Review can be approved; this one is ${card.status}.`);
    this.ctx.db.prepare(`UPDATE cards SET status = 'done', sent_back = 0, reopened = 0, updated_at = ? WHERE id = ?`).run(this.ctx.now(), card.id);
    this.log({ projectId: card.projectId, cardId: card.id, actor: OWNER, verb: 'approved', detail: note ?? null });
    if (note) this.comment(OWNER, card.id, note);
    this.changed(card.projectId, card.id, true);
    return this.card(card.id);
  }

  sendBack(cardId: string, note: string): CardSummary {
    const card = toCard(this.row(cardId));
    if (card.status !== 'review') throw new CoreError('refused', `Only a card in Review can be sent back; this one is ${card.status}.`);
    const why = text(note, 'note', MAX_TEXT);
    this.ctx.db.prepare(`UPDATE cards SET status = 'ready', sent_back = 1, updated_at = ? WHERE id = ?`).run(this.ctx.now(), card.id);
    this.log({ projectId: card.projectId, cardId: card.id, actor: OWNER, verb: 'sent back', detail: clip(why) });
    this.comment(OWNER, card.id, why);
    return this.card(card.id);
  }

  reopen(cardId: string, stillWrong: string): CardSummary {
    const card = toCard(this.row(cardId));
    if (card.status !== 'done') throw new CoreError('refused', `Only a Done card can be reopened; this one is ${card.status}.`);
    const what = text(stillWrong, 'what is still wrong', 500);
    this.ctx.db.transaction(() => {
      this.ctx.db.prepare(`UPDATE cards SET status = 'ready', reopened = 1, updated_at = ? WHERE id = ?`).run(this.ctx.now(), card.id);
      this.insertCriterion(card.id, what);
    })();
    this.log({ projectId: card.projectId, cardId: card.id, actor: OWNER, verb: 'reopened as not fixed', detail: what });
    this.changed(card.projectId, card.id, true);
    return this.card(card.id);
  }

  addEvidence(actor: Actor, cardId: string, input: EvidenceInput): void {
    const card = toCard(this.row(cardId));
    const sessionId = actorSessionId(actor);
    // An agent adds evidence to the card it is working, never to another agent's or to finished work.
    if (sessionId) this.assertHolds(sessionId, card);
    const root = this.project(card.projectId).path;
    const e = this.validEvidence(input, root);
    this.insertEvidence(card.id, actor, e);
    const shown = e.kind === 'file' && e.value.startsWith(`${root}/`) ? e.value.slice(root.length + 1) : e.value;
    this.log({ projectId: card.projectId, cardId: card.id, sessionId, actor, verb: 'added evidence', detail: clip(shown) });
    this.changed(card.projectId, card.id);
  }

  /* ── criteria ─────────────────────────────────────────────────────────── */

  addCriterion(actor: Actor, cardId: string, criterion: string): void {
    const card = this.row(cardId);
    const sessionId = actorSessionId(actor);
    // An agent sharpens the card it holds, or one it filed that is still waiting in the Inbox.
    if (sessionId && !(card.status === 'inbox' && card.created_by === actor)) this.assertHolds(sessionId, toCard(card));
    this.insertCriterion(card.id, text(criterion, 'criterion', 500));
    this.log({ projectId: card.project_id, cardId: card.id, actor, verb: 'added a criterion', detail: clip(criterion) });
    this.changed(card.project_id, card.id);
  }

  updateCriterion(params: { id: string; text?: string; done?: boolean }): void {
    const { db } = this.ctx;
    const row = db.prepare('SELECT c.*, k.project_id FROM criteria c JOIN cards k ON k.id = c.card_id WHERE c.id = ?')
      .get(params.id) as (CriterionRow & { project_id: string }) | undefined;
    if (!row) throw new CoreError('not_found', 'No such criterion.');
    if (params.text !== undefined) db.prepare('UPDATE criteria SET text = ? WHERE id = ?').run(text(params.text, 'criterion', 500), row.id);
    if (params.done !== undefined) {
      db.prepare('UPDATE criteria SET done = ? WHERE id = ?').run(params.done ? 1 : 0, row.id);
      this.log({ projectId: row.project_id, cardId: row.card_id, actor: OWNER, verb: params.done ? 'ticked' : 'unticked', detail: clip(row.text) });
    }
    this.changed(row.project_id, row.card_id);
  }

  removeCriterion(id: string): void {
    const row = this.ctx.db.prepare('SELECT c.card_id, k.project_id FROM criteria c JOIN cards k ON k.id = c.card_id WHERE c.id = ?')
      .get(id) as { card_id: string; project_id: string } | undefined;
    if (!row) throw new CoreError('not_found', 'No such criterion.');
    this.ctx.db.prepare('DELETE FROM criteria WHERE id = ?').run(id);
    this.changed(row.project_id, row.card_id);
  }

  /* ── leases ───────────────────────────────────────────────────────────── */

  /**
   * Renew claims whose session is alive; release the rest. A lease is a promise
   * that someone is working, so it is only renewed on evidence that they are.
   */
  sweepLeases(liveSessions: ReadonlySet<string>): void {
    const { db } = this.ctx;
    const now = this.ctx.now();
    const due = db.prepare('SELECT * FROM cards WHERE claim_session IS NOT NULL AND claim_expires <= ?').all(now + 60_000) as CardRow[];
    for (const row of due) {
      const sessionId = row.claim_session as string;
      if (liveSessions.has(sessionId)) {
        db.prepare('UPDATE cards SET claim_expires = ? WHERE id = ?').run(now + LEASE_MS, row.id);
      } else if ((row.claim_expires ?? 0) <= now) {
        db.prepare(`UPDATE cards SET status = CASE WHEN status = 'working' THEN 'ready' ELSE status END,
                    claim_session = NULL, claim_expires = NULL, claim_note = NULL, updated_at = ? WHERE id = ?`).run(now, row.id);
        this.log({ projectId: row.project_id, cardId: row.id, sessionId, actor: SYSTEM, verb: 'released an expired claim', detail: sessionActor(sessionId) });
        this.changed(row.project_id, row.id, true);
      }
    }
  }

  /**
   * A session taking over another's work (the same conversation, continued on
   * another account) takes its claim with it. The claim moves in one step, so
   * the card is never free in between for someone else to take.
   */
  handOver(cardId: string, from: string, to: string): void {
    const now = this.ctx.now();
    const row = this.row(cardId);
    const moved = this.ctx.db.prepare('UPDATE cards SET claim_session = ?, claim_expires = ?, updated_at = ? WHERE id = ? AND claim_session = ?')
      .run(to, now + LEASE_MS, now, row.id, from);
    if (!moved.changes) throw new CoreError('conflict', 'The card’s claim changed hands while it was being handed over.');
    this.log({ projectId: row.project_id, cardId: row.id, sessionId: to, actor: SYSTEM, verb: 'handed the claim to the session that continues the work', detail: sessionActor(from) });
    this.changed(row.project_id, row.id, true);
  }

  /** A session ended: give back whatever it still held, and say so. */
  releaseAllHeldBy(sessionId: string, endState: SessionState): void {
    const rows = this.ctx.db.prepare('SELECT * FROM cards WHERE claim_session = ?').all(sessionId) as CardRow[];
    for (const row of rows) {
      this.ctx.db.prepare(`UPDATE cards SET status = CASE WHEN status = 'working' THEN 'ready' ELSE status END,
                  claim_session = NULL, claim_expires = NULL, claim_note = NULL, updated_at = ? WHERE id = ?`).run(this.ctx.now(), row.id);
      this.log({ projectId: row.project_id, cardId: row.id, sessionId, actor: SYSTEM, verb: 'released the claim', detail: `the session ${endState} without submitting` });
      this.changed(row.project_id, row.id, true);
    }
  }

  /* ── decisions ────────────────────────────────────────────────────────── */

  decisions(projectId: string): Decision[] {
    this.project(projectId);
    return (this.ctx.db.prepare('SELECT * FROM decisions WHERE project_id = ? AND removed_at IS NULL ORDER BY created_at')
      .all(projectId) as DecisionRow[]).map(toDecision);
  }

  addDecision(params: { projectId: string; title: string; body?: string }): Decision {
    this.project(params.projectId);
    const id = randomUUID();
    const now = this.ctx.now();
    this.ctx.db.prepare('INSERT INTO decisions (id, project_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, params.projectId, text(params.title, 'decision', MAX_TITLE), params.body ? text(params.body, 'detail', MAX_TEXT, true) : '', now, now);
    this.log({ projectId: params.projectId, actor: OWNER, verb: 'recorded a decision', detail: params.title });
    this.ctx.emit('decisions', { projectId: params.projectId });
    return this.decision(id);
  }

  updateDecision(params: { id: string; title?: string; body?: string }): Decision {
    const d = this.decision(params.id);
    this.ctx.db.prepare('UPDATE decisions SET title = ?, body = ?, updated_at = ? WHERE id = ?').run(
      params.title !== undefined ? text(params.title, 'decision', MAX_TITLE) : d.title,
      params.body !== undefined ? text(params.body, 'detail', MAX_TEXT, true) : d.body,
      this.ctx.now(), d.id);
    this.log({ projectId: d.projectId, actor: OWNER, verb: 'changed a decision', detail: params.title ?? d.title });
    this.ctx.emit('decisions', { projectId: d.projectId });
    return this.decision(d.id);
  }

  removeDecision(id: string): void {
    const d = this.decision(id);
    this.ctx.db.prepare('UPDATE decisions SET removed_at = ? WHERE id = ?').run(this.ctx.now(), id);
    this.log({ projectId: d.projectId, actor: OWNER, verb: 'withdrew a decision', detail: d.title });
    this.ctx.emit('decisions', { projectId: d.projectId });
  }

  private decision(id: string): Decision {
    const row = this.ctx.db.prepare('SELECT * FROM decisions WHERE id = ? AND removed_at IS NULL').get(id) as DecisionRow | undefined;
    if (!row) throw new CoreError('not_found', 'No such decision.');
    return toDecision(row);
  }

  /* ── activity ─────────────────────────────────────────────────────────── */

  activity(params: { projectId?: string; cardId?: string; limit?: number }): Activity[] {
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    const where: string[] = [];
    const values: unknown[] = [];
    if (params.projectId) { where.push('project_id = ?'); values.push(params.projectId); }
    if (params.cardId) { where.push('card_id = ?'); values.push(params.cardId); }
    const sql = `SELECT * FROM activity ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return (this.ctx.db.prepare(sql).all(...values, limit) as ActivityRow[]).map(toActivity);
  }

  log(entry: { projectId?: string | null; cardId?: string | null; sessionId?: string | null; actor: Actor; verb: string; detail?: string | null }): void {
    // The owner acting from a phone is recorded as from that phone.
    const actor = entry.actor === OWNER ? phoneActorNow() ?? OWNER : entry.actor;
    this.ctx.db.prepare('INSERT INTO activity (project_id, card_id, session_id, actor, verb, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(entry.projectId ?? null, entry.cardId ?? null, entry.sessionId ?? null, actor, entry.verb, entry.detail ?? null, this.ctx.now());
  }

  /* ── internals ────────────────────────────────────────────────────────── */

  private row(id: string): CardRow {
    const row = this.ctx.db.prepare('SELECT * FROM cards WHERE id = ? OR key = ?').get(id, id) as CardRow | undefined;
    if (!row) throw new CoreError('not_found', `No card ${id}.`);
    if (!row.claim_session || (row.claim_expires ?? 0) > this.ctx.now()) return row;
    const holder = this.ctx.db.prepare(`SELECT 1 FROM sessions WHERE id = ? AND state IN (${LIVE_SQL})`).get(row.claim_session);
    return holder ? this.renewed(row) : row;
  }

  /**
   * A claim whose session is still running is held, whatever its clock says.
   * After the machine sleeps, the lease reads as expired before the sweep has
   * had a chance to renew it, while the agent is still at work.
   */
  private renewed(row: CardRow): CardRow {
    const expires = this.ctx.now() + LEASE_MS;
    this.ctx.db.prepare('UPDATE cards SET claim_expires = ? WHERE id = ?').run(expires, row.id);
    return { ...row, claim_expires: expires };
  }

  private summarise(rows: CardRow[]): CardSummary[] {
    if (!rows.length) return [];
    const { db } = this.ctx;
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    const count = (table: string, extra = ''): Map<string, number> => new Map(
      (db.prepare(`SELECT card_id, count(*) AS n FROM ${table} WHERE card_id IN (${marks}) ${extra} GROUP BY card_id`).all(...ids) as
        { card_id: string; n: number }[]).map((r) => [r.card_id, r.n]),
    );
    const done = count('criteria', 'AND done = 1');
    const total = count('criteria');
    const comments = count('comments');
    const evidence = count('evidence');
    const jev = new Map((db.prepare(`SELECT card_id, read_json FROM jev_reads WHERE card_id IN (${marks})`).all(...ids) as
      { card_id: string; read_json: string }[]).map((r) => [r.card_id, parseRead(r.read_json)]));
    const questions = count('comments', "AND kind = 'question' AND resolved_at IS NULL");
    const holders = new Map((db.prepare(
      `SELECT c.id AS card_id, s.id, s.title, s.provider, s.state FROM cards c JOIN sessions s ON s.id = c.claim_session WHERE c.id IN (${marks})`,
    ).all(...ids) as { card_id: string; id: string; title: string; provider: Provider; state: SessionState }[])
      .map((r) => [r.card_id, { sessionId: r.id, title: r.title, provider: r.provider, state: r.state }]));
    const reviews = new Map((db.prepare(
      `SELECT card_id, state, result_json FROM ai_reviews r WHERE card_id IN (${marks})
       AND started_at = (SELECT max(started_at) FROM ai_reviews WHERE card_id = r.card_id)`,
    ).all(...ids) as { card_id: string; state: string; result_json: string | null }[]).map((r) => [r.card_id, reviewMark(r.state, r.result_json)]));
    // A card is live if a running session works it or holds its claim (an agent
    // can claim a second card through the CLI); the claim holder wins.
    const live = new Map((db.prepare(
      `SELECT c.id AS card_id, s.id, s.state, s.provider FROM cards c
       JOIN sessions s ON s.card_id = c.id OR s.id = c.claim_session
       WHERE c.id IN (${marks}) AND s.state IN (${LIVE_SQL})
       ORDER BY s.id IS c.claim_session, s.started_at`,
    ).all(...ids) as { card_id: string; id: string; state: SessionState; provider: string }[])
      .map((r) => [r.card_id, { sessionId: r.id, state: r.state, provider: r.provider as Provider }]));
    const now = this.ctx.now();
    return rows.map((row) => {
      const holderLive = row.claim_session !== null && live.get(row.id)?.sessionId === row.claim_session;
      return holderLive && (row.claim_expires ?? 0) <= now ? this.renewed(row) : row;
    }).map((r) => ({
      ...toCard(r),
      progress: { done: done.get(r.id) ?? 0, total: total.get(r.id) ?? 0 },
      commentCount: comments.get(r.id) ?? 0,
      evidenceCount: evidence.get(r.id) ?? 0,
      live: live.get(r.id) ?? null,
      jev: jev.get(r.id) ?? null,
      holder: holders.get(r.id) ?? null,
      openQuestions: questions.get(r.id) ?? 0,
      aiReview: reviews.get(r.id) ?? null,
    }));
  }

  private insertCriterion(cardId: string, criterion: string): void {
    const max = this.ctx.db.prepare('SELECT max(position) AS p FROM criteria WHERE card_id = ?').get(cardId) as { p: number | null };
    this.ctx.db.prepare('INSERT INTO criteria (id, card_id, text, position) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), cardId, criterion, (max.p ?? 0) + 1);
  }

  private validEvidence(input: EvidenceInput, projectPath: string): EvidenceInput & { existed: boolean | null } {
    if (!EVIDENCE_KINDS.includes(input.kind)) throw new CoreError('invalid', `Evidence is one of ${EVIDENCE_KINDS.join(', ')}.`);
    const value = text(input.value, 'evidence', MAX_TEXT);
    if (input.kind === 'file') {
      const path = resolve(projectPath, value);
      // A folder proves nothing: a bare `--evidence` once resolved to the working folder and counted.
      if (isDirectory(path)) throw new CoreError('invalid', `${value} is a folder. Evidence is a file, a link or a note.`);
      return { kind: 'file', value: path, existed: existsSync(path) };
    }
    if (input.kind === 'link' && !/^https?:\/\//i.test(value)) throw new CoreError('invalid', 'A link starts with http:// or https://.');
    return { kind: input.kind, value, existed: null };
  }

  private insertEvidence(cardId: string, actor: Actor, e: EvidenceInput & { existed: boolean | null }): void {
    this.ctx.db.prepare('INSERT INTO evidence (id, card_id, kind, value, existed, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), cardId, e.kind, e.value, e.existed === null ? null : e.existed ? 1 : 0, actor, this.ctx.now());
  }

  private assertSameProject(sessionId: string, projectId: string): void {
    const s = this.ctx.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as { project_id: string } | undefined;
    if (!s) throw new CoreError('not_found', 'No such session.');
    if (s.project_id !== projectId) throw new CoreError('forbidden', 'That card belongs to another project.');
  }

  private assertHolds(sessionId: string, card: { projectId: string; claim: { sessionId: string; expiresAt: number } | null }): void {
    this.assertSameProject(sessionId, card.projectId);
    if (!card.claim || card.claim.sessionId !== sessionId || card.claim.expiresAt <= this.ctx.now()) {
      throw new CoreError('refused', 'You do not hold this card. Claim it first.');
    }
  }

  private changed(projectId: string, cardId: string | null, needs = false): void {
    this.ctx.emit('board', { projectId, cardId });
    this.ctx.emit('projects', {});
    if (needs) this.ctx.emit('needs', {});
  }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function text(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new CoreError('invalid', `The ${field} must be text.`);
  const v = value.trim();
  if (!v && !allowEmpty) throw new CoreError('invalid', `The ${field} cannot be empty.`);
  if (v.length > max) throw new CoreError('invalid', `The ${field} is too long (${v.length} > ${max} characters).`);
  return v;
}

const clip = (s: string, max = 140): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
