// The board (Studio): one toolbar (Board or List, the filters, saved views, the
// order, New card), the lanes on the canvas with the cards as panels on them, and
// the count at the status line's end. The List is the board's other mode
// (ListView.tsx): it shares this toolbar, its filters and its saved views.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactElement, type RefObject } from 'react';
import { CARD_TYPES, COLUMNS, LIVE_STATES, PRIORITIES, PROVIDERS, type CardSummary, type CardType, type Priority, type ProjectSummary, type Provider } from '@shared/model';
import { MAX_VIEW_FILTER, readBoardView, type BoardAgent, type BoardSort, type BoardView, type SavedBoardView } from '@shared/board-views';
import { keyLabel } from '@shared/shortcuts';
import { attempt, call, forProject, useQuery, type Query } from '../lib/api';
import { href, navigate, openCard, useLocation } from '../lib/router';
import { PROVIDER_LABEL, STATE_LABEL, STATUS_LABEL, TYPE_LABEL, duration, plural } from '../lib/format';
import { Icon } from '../components/icons';
import { Badge, Button, Count, EmptyState, IconButton, NotAnswering, StateMark, TypeMark, isMac, tipProps, useToast } from '../components/ui';
import { Toolbar } from '../components/Toolbar';
import { NavTabs } from '../components/Tabs';
import { StatusSlot } from '../components/StatusLine';
import type { DialogState } from '../App';
import { SinceStrip } from './SinceStrip';
import { JevChip, JevStrip } from '../components/Jev';
import { HowItWorks } from './HowItWorks';
import { Select } from '../components/Select';
import { MenuButton, type MenuItem } from '../components/Menu';
import { orbPlay } from '../components/Orb';
import { SavedViews } from './SavedViews';
import { HowButton } from '../components/How';
import { useHow } from '../lib/how';

type Column = (typeof COLUMNS)[number];

const sorts = (mac: boolean): readonly { value: BoardSort; label: string; detail?: string }[] => [
  { value: 'manual', label: 'Your order', detail: `Drag cards, or ${keyLabel('Mod', mac)} and the arrows, to arrange them` },
  { value: 'priority', label: 'Priority' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'stuck', label: 'Longest in column' },
  { value: 'jev', label: 'Jev: matters most' },
];

const AGENTS: readonly { value: BoardAgent; label: string }[] = [
  { value: 'any', label: 'Any agent' },
  ...PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] })),
  { value: 'none', label: 'No agent on it' },
];

/** What an empty column says: what it is for, at the moment it has nothing. */
const COLUMN_EMPTY: Record<Column, string> = {
  inbox: 'Nothing filed',
  ready: 'Nothing ready. Accept from the Inbox.',
  working: 'No session on anything',
  review: 'Nothing to review',
  done: 'Nothing approved yet',
};

/** A card open longer than this in one column is shown as stuck. */
const STUCK_MS = 7 * 86_400_000;

export const PRIORITY_MEANING: Record<Priority, string> = { 0: 'drop everything', 1: 'high', 2: 'normal', 3: 'low' };

/** The agent doing a card's work: the session holding it, or the live one on it. */
const agentOf = (c: CardSummary): Provider | null => c.holder?.provider ?? c.live?.provider ?? null;

const COLUMN_HINT: Record<Column, string> = {
  inbox: 'Filed by agents or you, waiting to be accepted',
  ready: 'Accepted and ready for a session to take',
  working: 'Held by a session',
  review: 'Submitted with evidence; yours to approve or send back',
  done: 'Approved',
};
const DONE_SHOWN = 12;

/* ── the board's view: filters, order and saved views, shared by Board and List ── */

export interface BoardViewState {
  filter: string;
  setFilter: (v: string) => void;
  types: ReadonlySet<CardType>;
  toggleType: (t: CardType) => void;
  sort: BoardSort;
  setSort: (v: BoardSort) => void;
  priority: Priority | 'any';
  setPriority: (v: Priority | 'any') => void;
  agent: BoardAgent;
  setAgent: (v: BoardAgent) => void;
  /** The saved view the board was last set from, if any. */
  applied: string | null;
  setApplied: (id: string | null) => void;
  current: BoardView;
  apply: (saved: SavedBoardView) => void;
  filtering: boolean;
  clear: () => void;
  views: Query<SavedBoardView[]>;
  /** Whether a card passes the filters (not the order). */
  matches: (c: CardSummary) => boolean;
}

/**
 * Each board opens the way it was left: its filter, types and order, and the saved view it was set from, in either
 * mode. Keys 1–9 apply the saved views in their order, as the panel lists them.
 */
export function useBoardView(projectId: string): BoardViewState {
  const remembered = useMemo(() => readView(projectId), [projectId]);
  const [filter, setFilter] = useState(remembered.view.filter);
  const [types, setTypes] = useState<ReadonlySet<CardType>>(new Set(remembered.view.types));
  const [sort, setSort] = useState<BoardSort>(remembered.view.sort);
  const [priority, setPriority] = useState<Priority | 'any'>(remembered.view.priority);
  const [agent, setAgent] = useState<BoardAgent>(remembered.view.agent);
  const [applied, setApplied] = useState<string | null>(remembered.applied);
  const current = useMemo<BoardView>(() => ({ filter, types: CARD_TYPES.filter((t) => types.has(t)), sort, priority, agent }), [filter, types, sort, priority, agent]);
  useEffect(() => { writeView(projectId, current, applied); }, [projectId, current, applied]);
  const views = useQuery('boardViews.list', { projectId }, ['boardViews'], forProject(projectId));
  const apply = useCallback((saved: SavedBoardView): void => {
    const v = saved.view;
    setFilter(v.filter); setTypes(new Set(v.types)); setSort(v.sort); setPriority(v.priority); setAgent(v.agent); setApplied(saved.id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('.xterm, .drawer, .chat, [role="dialog"], [role="listbox"]'))) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const saved = views.data?.[Number(e.key) - 1];
      if (!saved) return;
      e.preventDefault();
      apply(saved);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [views.data, apply]);
  const filtering = Boolean(filter.trim()) || types.size > 0 || priority !== 'any' || agent !== 'any';
  const clear = useCallback((): void => { setFilter(''); setTypes(new Set()); setPriority('any'); setAgent('any'); }, []);
  const toggleType = useCallback((t: CardType): void => setTypes((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; }), []);
  const q = filter.trim().toLowerCase();
  const matches = useCallback((c: CardSummary): boolean =>
    (!types.size || types.has(c.type)) &&
    (priority === 'any' || c.priority === priority) &&
    (agent === 'any' || (agent === 'none' ? agentOf(c) === null : agentOf(c) === agent)) &&
    (!q || c.title.toLowerCase().includes(q) || c.key.toLowerCase().includes(q) || c.body.toLowerCase().includes(q)), [types, priority, agent, q]);
  return { filter, setFilter, types, toggleType, sort, setSort, priority, setPriority, agent, setAgent, applied, setApplied, current, apply, filtering, clear, views, matches };
}

/** Set when Board or List is chosen in the toolbar: the view that opens puts the keys back on its tab. */
let modeChosen = false;

/**
 * The board's one toolbar, in either mode: Board or List; the filter, the card types, priority and agent; the saved
 * views; the order (on the board); how it works; and New card, its one primary action.
 */
export function BoardToolbar({ project, mode, board, setDialog, onHow }: {
  project: ProjectSummary;
  mode: 'board' | 'list';
  board: BoardViewState;
  setDialog?: (d: DialogState) => void;
  onHow?: () => void;
}) {
  const { card: openKey } = useLocation();
  const modes = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!modeChosen) return;
    modeChosen = false;
    modes.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }, []);
  const order = useMemo(() => sorts(isMac()), []);
  // Priority and agent, in one menu: each a choice of one, the button saying what is chosen.
  const filterItems: MenuItem[] = [
    { id: 'priority-any', group: 'Priority', label: 'Any priority', kind: 'radio', checked: board.priority === 'any', run: () => board.setPriority('any') },
    ...PRIORITIES.map((p): MenuItem => ({ id: `priority-${p}`, group: 'Priority', label: `P${p}`, detail: PRIORITY_MEANING[p], kind: 'radio', checked: board.priority === p, run: () => board.setPriority(p) })),
    ...AGENTS.map((a): MenuItem => ({ id: `agent-${a.value}`, group: 'Agent', label: a.label, kind: 'radio', checked: board.agent === a.value, run: () => board.setAgent(a.value) })),
  ];
  const narrowed = [board.priority === 'any' ? null : `P${board.priority}`, board.agent === 'any' ? null : AGENTS.find((a) => a.value === board.agent)?.label].filter(Boolean).join(' · ');
  const to = (view: 'board' | 'list'): string => href({ name: 'project', projectKey: project.key, view }, openKey);
  return (
    <Toolbar label="Cards" className="board-toolbar">
      <span ref={modes} className="board-modes" data-tour="board-modes" onClickCapture={(e) => { if ((e.target as Element).closest('a')) modeChosen = true; }}>
        <NavTabs label="Show the cards as" className="tabs-s" items={[
          { href: to('board'), label: 'Board', current: mode === 'board', keys: 'go-board', tip: 'The board: a lane for each step' },
          { href: to('list'), label: 'List', current: mode === 'list', keys: 'go-list', tip: 'Every card in one table, archived ones too' },
        ]} />
      </span>
      <div className="board-filters" data-tour="board-filters">
      <label className="search-field board-search">
        <Icon name="search" size={14} />
        <span className="visually-hidden">Filter cards</span>
        <input value={board.filter} maxLength={MAX_VIEW_FILTER} onChange={(e) => board.setFilter(e.target.value)} placeholder="Filter cards" />
      </label>
      <div className="chips board-types" role="group" aria-label="Card types">
        {CARD_TYPES.map((t) => (
          <button key={t} type="button" className={`chip${board.types.has(t) ? ' on' : ''}`} aria-pressed={board.types.has(t)}
            {...tipProps(`Only ${TYPE_LABEL[t].toLowerCase()}s`)} onClick={() => board.toggleType(t)}>
            <TypeMark type={t} label />
          </button>
        ))}
      </div>
      <MenuButton label={`Filter by priority and agent${narrowed ? `: ${narrowed}` : ''}`} items={filterItems} width={240}
        className={`btn-plain btn-s board-filter${narrowed ? ' on' : ''}`} tip="Priority and agent">
        <span className="board-filter-text">{narrowed || 'Priority, agent'}</span>
        <Icon name="down" size={12} />
      </MenuButton>
      {board.filtering ? <Button size="s" tone="quiet" onClick={board.clear}>Clear</Button> : null}
      </div>
      <div className="board-toolbar-end">
        <SavedViews projectId={project.id} views={board.views} current={board.current} appliedId={board.applied} onApply={board.apply} setApplied={board.setApplied} />
        {mode === 'board' ? <Select<BoardSort> label="Order" size="s" className="board-order" value={board.sort} onChange={board.setSort} options={order} /> : null}
        {onHow ? <span className="board-how" data-tour="board-how" {...tipProps('The board’s rules as a picture, with live numbers')}><HowButton onClick={onHow} /></span> : null}
        {setDialog ? (
          <Button tone="primary" size="s" icon="plus" keys="new-card" className="board-new" data-tour="board-new" onClick={() => setDialog({ kind: 'card', projectId: project.id })}>New card</Button>
        ) : null}
      </div>
    </Toolbar>
  );
}

/** How many cards, and how many the filters let through, at the status line's end. */
export function CardCount({ cards, matching, filtering, noun = 'open card' }: { cards: unknown[] | undefined; matching: number; filtering: boolean; noun?: string }) {
  return (
    <StatusSlot>
      <span className="board-count" aria-live="polite">{cards ? `${plural(cards.length, noun)}${filtering ? ` · ${matching} matching` : ''}` : ''}</span>
    </StatusSlot>
  );
}

export function Board({ project, setDialog }: { project: ProjectSummary; setDialog: (d: DialogState) => void }) {
  const cards = useQuery('cards.list', { projectId: project.id }, ['board', 'sessions'], forProject(project.id));
  const toast = useToast();
  const { card: openKey } = useLocation();
  const board = useBoardView(project.id);
  const { sort, matches, filtering } = board;
  const how = useHow('board');
  const [allDone, setAllDone] = useState(false);
  const [drag, setDrag] = useState<{ id: string; from: Column } | null>(null);
  const [drop, setDrop] = useState<{ column: Column; index: number } | null>(null);
  const [optimistic, setOptimistic] = useState<{ id: string; column: Column; index: number; data: unknown } | null>(null);
  const mac = isMac();

  const columns = useMemo(() => {
    const visible = (cards.data ?? []).filter(matches);
    const by: Record<Column, CardSummary[]> = { inbox: [], ready: [], working: [], review: [], done: [] };
    // A status this window does not know (a newer core's) is left off, not a crash.
    for (const c of visible) by[c.status as Column]?.push(c);
    const order = (a: CardSummary, b: CardSummary): number =>
      sort === 'priority' ? a.priority - b.priority || a.rank - b.rank
        : sort === 'newest' ? b.createdAt - a.createdAt
        : sort === 'oldest' ? a.createdAt - b.createdAt
        : sort === 'stuck' ? a.statusAt - b.statusAt
        : sort === 'jev' ? (b.jev?.severity ?? -1) - (a.jev?.severity ?? -1) || a.rank - b.rank
          : a.rank - b.rank;
    for (const col of COLUMNS) by[col].sort(col === 'done' && sort === 'manual' ? (a, b) => b.updatedAt - a.updatedAt : order);
    // Show a just-moved card where it was put until the core confirms.
    if (optimistic && optimistic.data === cards.data) {
      for (const col of COLUMNS) {
        const i = by[col].findIndex((c) => c.id === optimistic.id);
        if (i >= 0) {
          const [moved] = by[col].splice(i, 1);
          if (moved) by[optimistic.column].splice(Math.min(optimistic.index, by[optimistic.column].length), 0, { ...moved, status: optimistic.column });
        }
      }
    }
    return by;
  }, [cards.data, matches, sort, optimistic]);

  const boardRef = useRef<HTMLDivElement>(null);
  const lastG = useRef(0);
  // A card that changes column glides there, so a move is seen, not just noticed later.
  useGlide(boardRef, columns, drag?.id ?? null);

  const total = cards.data?.length ?? 0;
  const open = (cards.data ?? []).filter((c) => c.status !== 'done' && c.status !== 'archived');
  const matching = COLUMNS.reduce((n, col) => n + (col === 'done' ? 0 : columns[col].length), 0);
  const working = columns.working;
  const firstKey = COLUMNS.map((col) => columns[col][0]?.key).find(Boolean) ?? null;
  const held = working.filter((c) => c.claim).length;
  const running = working.filter((c) => c.live).length;

  /**
   * Put a card in a column at a place, as a drop or ⌘ and an arrow does, by the board's rules: Working is a session
   * started on it, Review needs evidence, Done from Review is an approval, and a Done card is reopened from itself.
   */
  async function moveTo(card: CardSummary, column: Column, index: number): Promise<void> {
    const from = card.status as Column;
    const siblings = columns[column].filter((c) => c.id !== card.id);
    const before = siblings[index - 1]?.id ?? null;
    const after = siblings[index]?.id ?? null;
    if (column === from && sort !== 'manual') return; // reordering only means something in manual order
    if (column === 'working') {
      if (card.status === 'working') return;
      setDialog({ kind: 'session', projectId: project.id, cardId: card.id });
      return;
    }
    if (card.status === 'done' && column !== 'done') {
      openCard(card.key);
      toast('Reopen it from the card and say what is still wrong.');
      return;
    }
    if (column === 'review' && card.status !== 'review' && card.evidenceCount === 0) {
      openCard(card.key);
      toast('Review needs evidence. Add a file, a link or a note to the card first.');
      return;
    }
    // Shown where it was put until the core's next answer replaces the cards this placement was made on (the board
    // event follows the move), so it never flickers back meanwhile; a refused move puts it back at once.
    setOptimistic({ id: card.id, column, index, data: cards.data });
    const done = column === 'done' && card.status === 'review'
      ? await attempt(() => call('cards.approve', { id: card.id }), (m) => toast(m, 'error'))
      : await attempt(() => call('cards.move', { id: card.id, status: column, before, after }), (m) => toast(m, 'error'));
    if (done === undefined) { setOptimistic(null); return; }
    if (column === 'done' && card.status === 'review') { toast(`${card.key} approved.`, 'done'); orbPlay(document.querySelector('.rail-orb'), 'burst'); }
  }

  function onDragStart(e: DragEvent, card: CardSummary): void {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.key);
    setDrag({ id: card.id, from: card.status as Column });
  }

  function onDragOver(e: DragEvent<HTMLElement>, column: Column): void {
    if (!drag) return;
    e.preventDefault();
    const list = e.currentTarget.querySelector('.column-cards');
    const tiles = list ? [...list.querySelectorAll<HTMLElement>('.card:not(.dragging)')] : [];
    let index = tiles.length;
    for (let i = 0; i < tiles.length; i++) {
      const r = (tiles[i] as HTMLElement).getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { index = i; break; }
    }
    if (drop?.column !== column || drop.index !== index) setDrop({ column, index });
  }

  async function onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    const moving = drag;
    const target = drop;
    setDrag(null);
    setDrop(null);
    if (!moving || !target) return;
    const card = cards.data?.find((c) => c.id === moving.id);
    if (card) await moveTo(card, target.column, target.index);
  }

  /** The keys back on a card that moved, wherever it is drawn now. */
  const refocus = (key: string): void => {
    requestAnimationFrame(() => {
      const el = boardRef.current?.querySelector<HTMLElement>(`.card[data-key="${CSS.escape(key)}"]`);
      if (el) { el.focus(); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    });
  };

  /**
   * Keyboard on the board: J/K or ↓/↑ within a column, H/L or ←/→ across columns, Enter to open. ⌘ (Ctrl) and an
   * arrow moves the card itself, as a drag does: up and down in your order, left and right a column. In the Inbox, A
   * accepts to Ready and X archives.
   */
  async function onBoardKey(e: React.KeyboardEvent<HTMLDivElement>): Promise<void> {
    const target = e.target as HTMLElement;
    if (!target.classList.contains('card') || e.altKey) return;
    const tiles = (col: Element | null): HTMLElement[] => (col ? [...col.querySelectorAll<HTMLElement>('.card')] : []);
    const column = target.closest('.column');
    const columnsEls = [...e.currentTarget.querySelectorAll('.column')];
    const ci = columnsEls.indexOf(column as Element);
    const ri = tiles(column).indexOf(target);
    const card = cards.data?.find((c) => c.key === target.dataset.key);
    const arrow = e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    if (arrow && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (!card) return;
      const from = COLUMNS[ci] as Column;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (sort !== 'manual' || from === 'done') {
          toast(from === 'done' ? 'Done keeps the newest approval first.' : 'Cards keep a place of their own in Your order: choose it under Order to arrange them.');
          return;
        }
        const to = ri + (e.key === 'ArrowUp' ? -1 : 1);
        if (to < 0 || to >= columns[from].length) return;
        await moveTo(card, from, to);
      } else {
        const next = COLUMNS[ci + (e.key === 'ArrowLeft' ? -1 : 1)];
        if (!next) return;
        await moveTo(card, next, Math.min(ri, columns[next].length));
      }
      refocus(card.key);
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    // G starts the app's two-key jumps (G then A is Activity): the key after it
    // is the app's, not a board key, or G A would accept the focused card.
    if (e.key === 'g') { lastG.current = Date.now(); return; }
    if (Date.now() - lastG.current < 1200) { lastG.current = 0; return; }
    const focus = (c: number, r: number): void => {
      const list = tiles(columnsEls[c] ?? null);
      const el = list[Math.max(0, Math.min(r, list.length - 1))];
      if (el) { el.focus(); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    };
    const key = e.key.toLowerCase();
    if (key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); focus(ci, ri + 1); }
    else if (key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); focus(ci, ri - 1); }
    else if (key === 'l' || e.key === 'ArrowRight') {
      e.preventDefault();
      for (let c = ci + 1; c < columnsEls.length; c++) if (tiles(columnsEls[c] ?? null).length) { focus(c, ri); break; }
    } else if (key === 'h' || e.key === 'ArrowLeft') {
      e.preventDefault();
      for (let c = ci - 1; c >= 0; c--) if (tiles(columnsEls[c] ?? null).length) { focus(c, ri); break; }
    } else if ((key === 'a' || key === 'x') && column?.classList.contains('column-inbox')) {
      e.preventDefault();
      e.stopPropagation();
      if (!card) return;
      const next = tiles(column)[ri + 1] ?? tiles(column)[ri - 1];
      const status = key === 'a' ? 'ready' : 'archived';
      const done = await attempt(() => call('cards.move', { id: card.id, status }), (m) => toast(m, 'error'));
      if (done) { toast(key === 'a' ? `${card.key} accepted to Ready.` : `${card.key} archived.`); next?.focus(); }
    }
  }

  const newCard = (status?: 'inbox' | 'ready'): void => setDialog({ kind: 'card', projectId: project.id, ...(status ? { status } : {}) });

  return (
    <div className="board-wrap">
      <BoardToolbar project={project} mode="board" board={board} setDialog={setDialog} onHow={how.show} />
      {how.open ? <HowItWorks project={project} cards={cards.data} onClose={how.hide} showColumn={showColumn} /> : null}
      <JevStrip project={project} />
      <div className="board-canvas">
        <SinceStrip key={project.id} projectId={project.id} cards={cards.data} />
        {cards.error ? <NotAnswering error={cards.error} onRetry={cards.reload} /> : !cards.loading && total === 0 ? (
          <EmptyState icon="board" title="This board is empty" action={<Button tone="primary" icon="plus" onClick={() => newCard()}>New card</Button>}>
            A card is the work: file one, start a session on it, and its agent takes it.
          </EmptyState>
        ) : (
          <div className="board" ref={boardRef} data-tour="board-lanes" aria-busy={cards.loading} aria-describedby="board-keys" onKeyDown={(e) => void onBoardKey(e)}>
            <p id="board-keys" className="visually-hidden">
              {`Enter opens a card. J and K move between cards, H and L between columns. ${keyLabel('Mod', mac)} with an arrow moves the card. In the Inbox, A accepts a card and X archives it.`}
            </p>
            {COLUMNS.map((col) => {
              const list = columns[col];
              const shown = col === 'done' && !allDone ? list.slice(0, DONE_SHOWN) : list;
              // Hit testing omits the dragged tile; the rendered list keeps its slot.
              const dragIndex = shown.findIndex((c) => c.id === drag?.id);
              const renderDropIndex = drop ? drop.index + (dragIndex >= 0 && drop.index >= dragIndex ? 1 : 0) : -1;
              return (
                <section
                  key={col}
                  className={`column column-${col}${drop?.column === col ? ' drop-target' : ''}`}
                  aria-label={`${STATUS_LABEL[col]}, ${plural(list.length, 'card')}`}
                  onDragOver={(e) => onDragOver(e, col)}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null); }}
                  onDrop={(e) => void onDrop(e)}
                >
                  <header className="column-head">
                    <span className={`col-glyph col-glyph-${col}`} aria-hidden="true" />
                    <h2 {...tipProps(COLUMN_HINT[col])}>{STATUS_LABEL[col]}</h2>
                    <Count key={list.length} n={list.length} tone={col === 'review' && list.length ? 'amber' : 'sunk'} className="column-count bump" />
                    {col === 'working' && held ? (
                      <span className="column-badge" {...tipProps(`${plural(held, 'card')} held by a session; ${running} with the session running now.`)}>
                        <Badge>{held} held · {running} live</Badge>
                      </span>
                    ) : null}
                    {col === 'inbox' || col === 'ready' ? (
                      <IconButton icon="plus" size="s" className="column-add" label={`New card in ${STATUS_LABEL[col]}`} onClick={() => newCard(col)} />
                    ) : null}
                  </header>
                  <ol className="column-cards">
                    {cards.loading && !cards.data ? <CardSkeletons n={col === 'ready' ? 3 : col === 'done' ? 1 : 2} /> : null}
                    {shown.map((c, i) => (
                      <li key={c.id} className="card-slot">
                        {drop?.column === col && renderDropIndex === i && drag?.id !== c.id ? <div className="drop-line" aria-hidden="true" /> : null}
                        <CardTile card={c} tour={c.key === firstKey} open={openKey === c.key} dragging={drag?.id === c.id} onDragStart={onDragStart} onDragEnd={() => { setDrag(null); setDrop(null); }} />
                      </li>
                    ))}
                    {drop?.column === col && renderDropIndex >= shown.length ? <li className="card-slot"><div className="drop-line" aria-hidden="true" /></li> : null}
                    {!shown.length && !drop && cards.data ? <li className="column-empty">{filtering ? 'No matching cards' : COLUMN_EMPTY[col]}</li> : null}
                  </ol>
                  {col === 'done' && list.length > DONE_SHOWN ? (
                    <Button size="s" tone="quiet" className="column-more" onClick={() => setAllDone((v) => !v)}>
                      {allDone ? 'Show recent only' : `Show all ${list.length}`}
                    </Button>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </div>
      <CardCount cards={cards.data ? open : undefined} matching={matching} filtering={filtering} />
    </div>
  );
}

/** Where cards will be while the board is read: quiet shapes, not a jump. */
function CardSkeletons({ n }: { n: number }) {
  return <>{Array.from({ length: n }, (_, i) => <li key={i} className="card-slot" aria-hidden="true"><div className="card-skeleton"><span /><span /></div></li>)}</>;
}

function CardTile({ card, tour, open, dragging, onDragStart, onDragEnd }: {
  card: CardSummary;
  /** The card a guided tour points at (the board's first). */
  tour: boolean;
  open: boolean;
  dragging: boolean;
  onDragStart: (e: DragEvent, c: CardSummary) => void;
  onDragEnd: () => void;
}) {
  const asking = card.live?.state === 'permission';
  return (
    <article
      className={`card${open ? ' open' : ''}${dragging ? ' dragging' : ''}${asking ? ' asking' : ''}`}
      draggable
      tabIndex={0}
      aria-label={`${card.key} ${card.title}`}
      aria-current={open ? 'true' : undefined}
      data-key={card.key}
      data-tour={tour ? 'board-card' : undefined}
      onDragStart={(e) => onDragStart(e, card)}
      onDragEnd={onDragEnd}
      onClick={() => openCard(card.key)}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openCard(card.key); } }}
    >
      <div className="card-head">
        <TypeMark type={card.type} />
        <span className="card-key mono">{card.key}</span>
        <span className="card-marks">
          {card.live && card.status !== 'working' ? <StateMark state={card.live.state} label={card.live.state === 'permission'} /> : null}
          {card.priority !== 2 ? <PriorityBadge priority={card.priority} /> : null}
        </span>
      </div>
      <p className="card-title">{card.title}</p>
      {card.status === 'working' ? <ClaimLine card={card} /> : null}
      <CardFoot card={card} />
    </article>
  );
}

/** P0, P1 and P3; a normal card (P2) carries no mark, so the ones that differ stand out. */
export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`prio prio-${priority}`} {...tipProps(`Priority P${priority}: ${PRIORITY_MEANING[priority]}`)}>P{priority}</span>;
}

/**
 * Who is on a Working card, and whether they are actually running: the most
 * important live fact on the board. One click opens the terminal.
 */
function ClaimLine({ card }: { card: CardSummary }) {
  const session = card.holder ?? (card.live ? { sessionId: card.live.sessionId, title: '', provider: card.live.provider, state: card.live.state } : null);
  if (!session) return null;
  const running = LIVE_STATES.has(session.state);
  const projectKey = card.key.split('-')[0] ?? '';
  const open = (e: { stopPropagation: () => void; preventDefault: () => void }): void => {
    e.stopPropagation();
    e.preventDefault();
    navigate({ name: 'session', projectKey, sessionId: session.sessionId });
  };
  return (
    <a
      className={`claim-line${running ? '' : ' stopped'}`}
      href={href({ name: 'session', projectKey, sessionId: session.sessionId })}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter') open(e); }}
      {...tipProps(running ? `${session.title || PROVIDER_LABEL[session.provider]}: ${STATE_LABEL[session.state]}. Open its terminal.` : 'The session holding this card is not running. Open it to see how it ended.')}
    >
      <StateMark state={session.state} label={false} />
      {session.state === 'permission' || session.state === 'limited' ? (
        <span className="claim-who claim-urgent">{STATE_LABEL[session.state]}</span>
      ) : (
        <>
          <span className="claim-who">{PROVIDER_LABEL[session.provider]}</span>
          <span className="claim-what">{running ? STATE_LABEL[session.state] : 'not running'}{card.claim?.note ? ` · ${card.claim.note}` : ''}</span>
        </>
      )}
      <Icon name="terminal" size={12} />
    </a>
  );
}

const REVIEW_MARK: Record<NonNullable<CardSummary['aiReview']>, { text: string; tone: string; tip: string }> = {
  running: { text: 'AI checking', tone: 'meta', tip: 'Claude is checking it against each criterion' },
  pass: { text: 'AI: looks done', tone: 'flag flag-green', tip: 'The AI review found proof for every criterion. Approving is still yours.' },
  changes: { text: 'AI: changes', tone: 'flag flag-red', tip: 'The AI review found a criterion not met' },
  unsure: { text: 'AI: your call', tone: 'meta', tip: 'The AI review could not decide; it needs a person' },
  failed: { text: 'AI: failed', tone: 'meta', tip: 'The AI review did not finish' },
};

function CardFoot({ card }: { card: CardSummary }) {
  const bits: ReactElement[] = [];
  if (card.openQuestions) bits.push(<span key="q" className="flag flag-amber" {...tipProps('An agent asked you something on this card')}>{card.openQuestions > 1 ? `${card.openQuestions} questions` : 'Question'}</span>);
  if (card.reopened) bits.push(<span key="r" className="flag flag-red" {...tipProps('Reopened as not fixed')}>Reopened</span>);
  if (card.sentBack) bits.push(<span key="s" className="flag card-sent-back" {...tipProps('Sent back with changes requested; the next session is told why')}>Sent back</span>);
  if (card.progress.total) {
    const done = card.progress.done === card.progress.total;
    bits.push(<span key="c" className={`meta${done ? ' meta-done' : ''}`} {...tipProps(`Acceptance criteria: ${card.progress.done} of ${card.progress.total} met`)}><Icon name="check" size={12} />{card.progress.done}/{card.progress.total}</span>);
  }
  if (card.evidenceCount && (card.status === 'review' || card.status === 'done')) {
    bits.push(<span key="e" className="meta" {...tipProps(plural(card.evidenceCount, 'piece of evidence', 'pieces of evidence'))}><Icon name="file" size={12} />{card.evidenceCount}</span>);
  }
  if (card.commentCount) bits.push(<span key="m" className="meta" {...tipProps(plural(card.commentCount, 'comment'))}><Icon name="note" size={12} />{card.commentCount}</span>);
  if (card.claim && !card.live) bits.push(<span key="h" className="meta" {...tipProps('Claimed, but no live session is attached')}>held</span>);
  if (card.aiReview && (card.status === 'review' || card.status === 'done')) {
    const m = REVIEW_MARK[card.aiReview];
    bits.push(<span key="a" className={m.tone} {...tipProps(m.tip)}>{m.text}</span>);
  }
  if (card.jev) bits.push(<JevChip key="j" card={card} />);
  if (card.status !== 'done') {
    const stuck = Date.now() - card.statusAt > STUCK_MS;
    bits.push(<span key="t" className={`card-age${stuck ? ' stuck' : ''}`} {...tipProps(`In ${STATUS_LABEL[card.status]} for ${duration(card.statusAt)}${stuck ? ': stuck' : ''}`)}>{duration(card.statusAt)}</span>);
  }
  return bits.length ? <div className="card-foot">{bits}</div> : null;
}

/** Scroll a column into view and ring it briefly, for "How this works". */
function showColumn(column: Column): void {
  const el = document.querySelector<HTMLElement>(`.column-${column}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  window.setTimeout(() => el.classList.remove('flash'), 1800);
}

/** The board as it was left in this window, and the saved view it was last set from (a convenience; the views themselves are the core's). */
function readView(projectId: string): { view: BoardView; applied: string | null } {
  try {
    const raw = JSON.parse(localStorage.getItem(`wanigan.board.${projectId}`) ?? '{}') as { applied?: unknown } | null;
    return { view: readBoardView(raw), applied: typeof raw?.applied === 'string' ? raw.applied : null };
  } catch {
    return { view: readBoardView(null), applied: null };
  }
}

function writeView(projectId: string, view: BoardView, applied: string | null): void {
  try { localStorage.setItem(`wanigan.board.${projectId}`, JSON.stringify({ ...view, applied })); } catch { /* a convenience only */ }
}

/** A motion token's value in ms, read from the stylesheet (instant under reduced motion). */
function tokenMs(name: string, fallback: number): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(v);
  return Number.isFinite(n) ? (v.endsWith('ms') ? n : n * 1000) : fallback;
}

/**
 * FLIP: remember where each card was, and when the board redraws, slide the
 * ones that moved from their old place to their new one. The card being
 * dragged is left alone (the owner already put it there); nothing moves under
 * reduced motion.
 */
function useGlide(root: RefObject<HTMLElement | null>, layout: unknown, dragging: string | null): void {
  const last = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const board = root.current;
    if (!board) return;
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = tokenMs('--dur-slow', 280);
    const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease').trim() || 'ease-out';
    const now = new Map<string, DOMRect>();
    for (const node of board.querySelectorAll<HTMLElement>('.card[data-key]')) {
      const key = node.dataset.key as string;
      const rect = node.getBoundingClientRect();
      now.set(key, rect);
      const before = last.current.get(key);
      if (calm || !before || node.classList.contains('dragging') || key === dragging) continue;
      const dx = before.left - rect.left;
      const dy = before.top - rect.top;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration, easing });
    }
    last.current = now;
  }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps
}
