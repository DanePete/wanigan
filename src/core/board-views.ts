// Board views the owner saves by name, one project's board at a time. Owner
// only (see ACCESS). Everything a view says is checked here before it is
// written: a name is one line, short, and unique on its board in any case; a
// view names only card types, orders, priorities and agents this build knows,
// and nothing else; a board keeps a bounded number of them. Views belong to
// their project: closing it keeps them, as it keeps the cards, and a project
// row deleted from the database takes its views with it (ON DELETE CASCADE).
import { randomUUID } from 'node:crypto';
import { CARD_TYPES, PRIORITIES, type CardType, type Priority } from '../shared/model.ts';
import {
  BOARD_AGENTS, BOARD_SORTS, MAX_VIEWS, MAX_VIEW_FILTER, MAX_VIEW_NAME, orderedTypes, readBoardView, viewNameKey,
  type BoardAgent, type BoardSort, type BoardView, type SavedBoardView,
} from '../shared/board-views.ts';
import { CoreError } from '../shared/protocol.ts';
import type { Board } from './board.ts';
import type { Ctx } from './context.ts';
import type { Handlers } from './handlers.ts';

interface ViewRow {
  id: string; project_id: string; name: string; name_key: string; filter: string; types: string; sort: string;
  priority: number | null; agent: string; created_at: number; updated_at: number;
}

/** A stored row as the window sees it. Read leniently: what a newer build wrote and this one does not know is left out. */
function toSaved(r: ViewRow): SavedBoardView {
  let types: unknown = [];
  try { types = JSON.parse(r.types); } catch { /* none */ }
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    view: readBoardView({ filter: r.filter, types, sort: r.sort, priority: r.priority ?? 'any', agent: r.agent }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const FIELDS = ['filter', 'types', 'sort', 'priority', 'agent'] as const;
// Control characters, and the direction marks that make a name read as something else.
const UNPLAIN = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

const invalid = (message: string): never => { throw new CoreError('invalid', message); };
const list = (items: readonly (string | number)[]): string => `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;

/** A name the owner gave a view: one line of plain text, trimmed, not empty and not too long. */
export function checkViewName(raw: unknown): string {
  if (typeof raw !== 'string') return invalid('Name the view.');
  const name = raw.trim();
  if (!name) return invalid('A saved view needs a name.');
  if (UNPLAIN.test(name)) return invalid('A view’s name is one line of plain text, without control or direction characters.');
  if (name.length > MAX_VIEW_NAME) return invalid(`A view’s name is at most ${MAX_VIEW_NAME} characters; this one is ${name.length}.`);
  return name;
}

/**
 * A view as the window sent it, checked field by field: all five present,
 * nothing else, and each a value the board knows. An unknown card type, order,
 * priority or agent is refused by name, never quietly dropped.
 */
export function checkView(raw: unknown): BoardView {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('A view is the board’s filter, card types, order, priority and agent.');
  const v = raw as Record<string, unknown>;
  const extra = Object.keys(v).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra.length) return invalid(`A board view keeps its filter, card types, order, priority and agent, not “${extra[0]}”.`);
  const missing = FIELDS.filter((f) => v[f] === undefined);
  if (missing.length) return invalid(`The view does not say its ${missing.join(', ')}.`);

  if (typeof v.filter !== 'string') return invalid('The filter is text.');
  const filter = v.filter.trim();
  if (filter.length > MAX_VIEW_FILTER) return invalid(`A saved filter is at most ${MAX_VIEW_FILTER} characters; this one is ${filter.length}.`);
  if (UNPLAIN.test(filter)) return invalid('A saved filter is one line of plain text.');

  if (!Array.isArray(v.types)) return invalid('The card types are a list.');
  if (v.types.length > CARD_TYPES.length) return invalid(`A view names each card type once, so at most ${CARD_TYPES.length}.`);
  const unknownType = v.types.find((t) => !(CARD_TYPES as readonly unknown[]).includes(t));
  if (unknownType !== undefined) return invalid(`“${String(unknownType)}” is not a card type: a board has ${list(CARD_TYPES)} cards.`);
  if (new Set(v.types).size !== v.types.length) return invalid('A view names each card type once.');

  if (!(BOARD_SORTS as readonly unknown[]).includes(v.sort)) return invalid(`“${String(v.sort)}” is not an order the board knows: ${list(BOARD_SORTS)}.`);
  if (v.priority !== 'any' && !(PRIORITIES as readonly unknown[]).includes(v.priority)) {
    return invalid(`The priority is any, or one of ${list(PRIORITIES)}, not “${String(v.priority)}”.`);
  }
  if (!(BOARD_AGENTS as readonly unknown[]).includes(v.agent)) return invalid(`“${String(v.agent)}” is not an agent the board knows: ${list(BOARD_AGENTS)}.`);
  return {
    filter,
    types: orderedTypes(v.types as CardType[]),
    sort: v.sort as BoardSort,
    priority: v.priority as Priority | 'any',
    agent: v.agent as BoardAgent,
  };
}

export class BoardViews {
  private readonly ctx: Ctx;
  private readonly board: Board;

  constructor(ctx: Ctx, board: Board) {
    this.ctx = ctx;
    this.board = board;
  }

  /** A project's saved views, oldest first: the order their keys (1–9) follow. */
  list(projectId: string): SavedBoardView[] {
    this.board.project(projectId);
    return (this.ctx.db.prepare('SELECT * FROM board_views WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as ViewRow[]).map(toSaved);
  }

  save(projectId: string, rawName: unknown, rawView: unknown): SavedBoardView {
    const project = this.board.project(projectId);
    const name = checkViewName(rawName);
    const view = checkView(rawView);
    const { db } = this.ctx;
    const id = randomUUID();
    db.transaction(() => {
      const { n } = db.prepare('SELECT count(*) AS n FROM board_views WHERE project_id = ?').get(project.id) as { n: number };
      if (n >= MAX_VIEWS) throw new CoreError('refused', `A board keeps at most ${MAX_VIEWS} saved views. Delete one you no longer use first.`);
      this.refuseTaken(project.id, name, null);
      const now = this.ctx.now();
      db.prepare(`INSERT INTO board_views (id, project_id, name, name_key, filter, types, sort, priority, agent, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, project.id, name, viewNameKey(name), view.filter, JSON.stringify(view.types), view.sort,
          view.priority === 'any' ? null : view.priority, view.agent, now, now);
    }).immediate();
    this.ctx.emit('boardViews', { projectId: project.id });
    return this.get(id);
  }

  /** Rename a view, or make it show what the board shows now; at least one of the two. */
  update(id: string, changes: { name?: unknown; view?: unknown }): SavedBoardView {
    const before = this.get(id);
    if (changes.name === undefined && changes.view === undefined) invalid('Give the view a new name, or what it should show.');
    const name = changes.name === undefined ? before.name : checkViewName(changes.name);
    const view = changes.view === undefined ? before.view : checkView(changes.view);
    const { db } = this.ctx;
    db.transaction(() => {
      this.refuseTaken(before.projectId, name, id);
      db.prepare('UPDATE board_views SET name = ?, name_key = ?, filter = ?, types = ?, sort = ?, priority = ?, agent = ?, updated_at = ? WHERE id = ?')
        .run(name, viewNameKey(name), view.filter, JSON.stringify(view.types), view.sort,
          view.priority === 'any' ? null : view.priority, view.agent, this.ctx.now(), id);
    }).immediate();
    this.ctx.emit('boardViews', { projectId: before.projectId });
    return this.get(id);
  }

  remove(id: string): void {
    const view = this.get(id);
    this.ctx.db.prepare('DELETE FROM board_views WHERE id = ?').run(id);
    this.ctx.emit('boardViews', { projectId: view.projectId });
  }

  private get(id: string): SavedBoardView {
    const row = this.ctx.db.prepare('SELECT * FROM board_views WHERE id = ?').get(id) as ViewRow | undefined;
    if (!row) throw new CoreError('not_found', 'No such saved view. It may have been deleted.');
    return toSaved(row);
  }

  /** Two views on one board never share a name, whatever its case. */
  private refuseTaken(projectId: string, name: string, except: string | null): void {
    const taken = this.ctx.db.prepare('SELECT name FROM board_views WHERE project_id = ? AND name_key = ? AND id IS NOT ?')
      .get(projectId, viewNameKey(name), except) as { name: string } | undefined;
    if (taken) throw new CoreError('conflict', `This board already has a view called “${taken.name}”.`);
  }
}

type ViewMethods = 'boardViews.list' | 'boardViews.save' | 'boardViews.update' | 'boardViews.remove';

export function boardViewsHandlers(views: BoardViews): Pick<Handlers, ViewMethods> {
  return {
    'boardViews.list': (p) => views.list(ref(p.projectId, 'project')),
    'boardViews.save': (p) => views.save(ref(p.projectId, 'project'), p.name, p.view),
    'boardViews.update': (p) => views.update(ref(p.id, 'saved view'), { name: p.name, view: p.view }),
    'boardViews.remove': (p) => { views.remove(ref(p.id, 'saved view')); return { ok: true }; },
  };
}

function ref(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 64) throw new CoreError('invalid', `Which ${what}?`);
  return v;
}
