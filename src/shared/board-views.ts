// What a board shows, and the views of it the owner saves by name. Each board
// keeps the view it was left in for itself, in the window; a saved view is the
// owner's own data, kept by the core and checked there when it is written
// (core/board-views.ts). Plain data and pure functions only.
import { CARD_TYPES, PRIORITIES, PROVIDERS, type CardType, type Priority } from './model.ts';

/** The orders a board can show its cards in. */
export const BOARD_SORTS = ['manual', 'priority', 'newest', 'oldest', 'stuck', 'jev'] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

/** Whose cards: any, one agent's (the session holding the card, or the live one on it), or none with an agent. */
export const BOARD_AGENTS = ['any', ...PROVIDERS, 'none'] as const;
export type BoardAgent = (typeof BOARD_AGENTS)[number];

export interface BoardView {
  /** Words a card's key, title or description contains, in any case; '' is every card. */
  filter: string;
  /** Only cards of these types; none is every type. */
  types: CardType[];
  sort: BoardSort;
  priority: Priority | 'any';
  agent: BoardAgent;
}

/** A board view the owner saved under a name, on one project's board. */
export interface SavedBoardView {
  id: string;
  projectId: string;
  name: string;
  view: BoardView;
  createdAt: number;
  updatedAt: number;
}

/** A board as it first opens: every card, in the owner's own order. */
export const DEFAULT_BOARD_VIEW: BoardView = { filter: '', types: [], sort: 'manual', priority: 'any', agent: 'any' };

/** The longest name a saved view may have. */
export const MAX_VIEW_NAME = 60;
/** The longest filter a saved view may keep. */
export const MAX_VIEW_FILTER = 200;
/** The most views one board keeps. */
export const MAX_VIEWS = 30;

const known = <T>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

/** Card types in the board's own order, each once. */
export const orderedTypes = (types: readonly CardType[]): CardType[] => CARD_TYPES.filter((t) => types.includes(t));

/**
 * A view as it was remembered or stored, made safe to show: a field this build
 * does not know (a card type, an order or an agent from a newer Wanigan) is
 * left out, and what is missing is the board as it first opens. Writing a view
 * is checked strictly instead, by the core.
 */
export function readBoardView(raw: unknown): BoardView {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    filter: typeof v.filter === 'string' ? v.filter.slice(0, MAX_VIEW_FILTER) : '',
    types: Array.isArray(v.types) ? orderedTypes(v.types.filter((t): t is CardType => known(CARD_TYPES, t))) : [],
    sort: known(BOARD_SORTS, v.sort) ? v.sort : DEFAULT_BOARD_VIEW.sort,
    priority: known(PRIORITIES, v.priority) ? v.priority : 'any',
    agent: known(BOARD_AGENTS, v.agent) ? v.agent : 'any',
  };
}

/**
 * Whether two views show the same cards in the same order. The filter matches
 * in any case and around its spaces, so neither makes a view different, and
 * the types are a set.
 */
export function sameView(a: BoardView, b: BoardView): boolean {
  const ta = new Set(a.types);
  const tb = new Set(b.types);
  return a.filter.trim().toLowerCase() === b.filter.trim().toLowerCase()
    && ta.size === tb.size && [...ta].every((t) => tb.has(t))
    && a.sort === b.sort && a.priority === b.priority && a.agent === b.agent;
}

/** A name as two names are compared: case and Unicode composition do not make them different. */
export const viewNameKey = (name: string): string => name.trim().normalize('NFC').toLowerCase();

/**
 * Which saved view the board is showing: the one last applied while the board
 * still matches it, else the first saved view it matches, else the one last
 * applied, changed since. Null when no saved view applies.
 */
export function shownView(views: readonly SavedBoardView[], current: BoardView, appliedId: string | null):
  { view: SavedBoardView; changed: boolean } | null {
  const applied = appliedId ? views.find((v) => v.id === appliedId) : undefined;
  if (applied && sameView(applied.view, current)) return { view: applied, changed: false };
  const matching = views.find((v) => sameView(v.view, current));
  if (matching) return { view: matching, changed: false };
  return applied ? { view: applied, changed: true } : null;
}
