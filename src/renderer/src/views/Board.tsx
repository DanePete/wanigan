import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactElement, type RefObject } from 'react';
import { CARD_TYPES, COLUMNS, LIVE_STATES, PRIORITIES, type CardSummary, type CardType, type Priority, type ProjectSummary, type Provider } from '@shared/model';
import { attempt, call, forProject, useQuery } from '../lib/api';
import { href, navigate, openCard, useLocation } from '../lib/router';
import { PROVIDER_LABEL, STATE_LABEL, STATUS_LABEL, TYPE_LABEL, duration, plural } from '../lib/format';
import { Icon } from '../components/icons';
import { Empty, NotAnswering, StateMark, TypeMark, useToast } from '../components/ui';
import type { DialogState } from '../App';
import { SinceStrip } from './SinceStrip';
import { JevChip, JevStrip } from '../components/Jev';
import { HowItWorks } from './HowItWorks';
import { Select } from '../components/Select';
import { orbPlay } from '../components/Orb';

type Column = (typeof COLUMNS)[number];
type Sort = 'manual' | 'priority' | 'newest' | 'oldest' | 'stuck' | 'jev';
type Agent = 'any' | Provider | 'none';

const SORTS: readonly { value: Sort; label: string; detail?: string }[] = [
  { value: 'manual', label: 'Your order', detail: 'Drag cards to arrange them' },
  { value: 'priority', label: 'Priority' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'stuck', label: 'Longest in column' },
  { value: 'jev', label: 'Jev: matters most' },
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

const PRIORITY_MEANING: Record<Priority, string> = { 0: 'drop everything', 1: 'high', 2: 'normal', 3: 'low' };

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

export function Board({ project, setDialog }: { project: ProjectSummary; setDialog: (d: DialogState) => void }) {
  const cards = useQuery('cards.list', { projectId: project.id }, ['board', 'sessions'], forProject(project.id));
  const toast = useToast();
  const { card: openKey } = useLocation();
  // Each board opens the way it was left: its filter, types and order.
  const remembered = useMemo(() => readView(project.id), [project.id]);
  const [filter, setFilter] = useState(remembered.filter);
  const [types, setTypes] = useState<ReadonlySet<CardType>>(new Set(remembered.types));
  const [sort, setSort] = useState<Sort>(remembered.sort);
  const [priority, setPriority] = useState<Priority | 'any'>(remembered.priority);
  const [agent, setAgent] = useState<Agent>(remembered.agent);
  const [how, setHow] = useState(false);
  useEffect(() => { writeView(project.id, { filter, types: [...types], sort, priority, agent }); }, [project.id, filter, types, sort, priority, agent]);
  const filtering = Boolean(filter.trim()) || types.size > 0 || priority !== 'any' || agent !== 'any';
  const clear = (): void => { setFilter(''); setTypes(new Set()); setPriority('any'); setAgent('any'); };
  const [allDone, setAllDone] = useState(false);
  const [drag, setDrag] = useState<{ id: string; from: Column } | null>(null);
  const [drop, setDrop] = useState<{ column: Column; index: number } | null>(null);
  const [optimistic, setOptimistic] = useState<{ id: string; column: Column; index: number; data: unknown } | null>(null);

  const columns = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const visible = (cards.data ?? []).filter((c) =>
      (!types.size || types.has(c.type)) &&
      (priority === 'any' || c.priority === priority) &&
      (agent === 'any' || (agent === 'none' ? agentOf(c) === null : agentOf(c) === agent)) &&
      (!q || c.title.toLowerCase().includes(q) || c.key.toLowerCase().includes(q) || c.body.toLowerCase().includes(q)));
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
    // Show a just-dropped card where it was dropped until the core confirms.
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
  }, [cards.data, filter, types, sort, priority, agent, optimistic]);

  const boardRef = useRef<HTMLDivElement>(null);
  const lastG = useRef(0);
  // A card that changes column glides there, so a move is seen, not just noticed later.
  useGlide(boardRef, columns, drag?.id ?? null);

  const total = cards.data?.length ?? 0;
  const open = (cards.data ?? []).filter((c) => c.status !== 'done' && c.status !== 'archived').length;
  const matching = COLUMNS.reduce((n, col) => n + (col === 'done' ? 0 : columns[col].length), 0);
  const working = columns.working;
  const held = working.filter((c) => c.claim).length;
  const running = working.filter((c) => c.live).length;

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

  async function onDrop(e: DragEvent, column: Column): Promise<void> {
    e.preventDefault();
    const moving = drag;
    const target = drop;
    setDrag(null);
    setDrop(null);
    if (!moving || !target) return;
    const card = cards.data?.find((c) => c.id === moving.id);
    if (!card) return;
    const siblings = columns[column].filter((c) => c.id !== card.id);
    const before = siblings[target.index - 1]?.id ?? null;
    const after = siblings[target.index]?.id ?? null;
    if (column === moving.from && sort !== 'manual') return; // reordering only means something in manual order

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
    setOptimistic({ id: card.id, column, index: target.index, data: cards.data });
    if (column === 'done' && card.status === 'review') {
      const approved = await attempt(() => call('cards.approve', { id: card.id }), (m) => toast(m, 'error'));
      if (approved !== undefined) { toast(`${card.key} approved.`); orbPlay(document.querySelector('.rail-orb'), 'burst'); }
    } else {
      await attempt(() => call('cards.move', { id: card.id, status: column, before, after }), (m) => toast(m, 'error'));
    }
    setOptimistic(null);
  }

  /**
   * Keyboard on the board: J/K or ↓/↑ within a column, H/L or ←/→ across
   * columns, Enter to open. In the Inbox, A accepts to Ready and X archives.
   */
  async function onBoardKey(e: React.KeyboardEvent<HTMLDivElement>): Promise<void> {
    const target = e.target as HTMLElement;
    if (!target.classList.contains('card') || e.metaKey || e.ctrlKey || e.altKey) return;
    // G starts the app's two-key jumps (G then A is Activity): the key after it
    // is the app's, not a board key, or G A would accept the focused card.
    if (e.key === 'g') { lastG.current = Date.now(); return; }
    if (Date.now() - lastG.current < 1200) { lastG.current = 0; return; }
    const tiles = (col: Element | null): HTMLElement[] => (col ? [...col.querySelectorAll<HTMLElement>('.card')] : []);
    const column = target.closest('.column');
    const columnsEls = [...e.currentTarget.querySelectorAll('.column')];
    const ci = columnsEls.indexOf(column as Element);
    const ri = tiles(column).indexOf(target);
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
      const card = cards.data?.find((c) => c.key === target.dataset.key);
      if (!card) return;
      const next = tiles(column)[ri + 1] ?? tiles(column)[ri - 1];
      const status = key === 'a' ? 'ready' : 'archived';
      const done = await attempt(() => call('cards.move', { id: card.id, status }), (m) => toast(m, 'error'));
      if (done) { toast(key === 'a' ? `${card.key} accepted to Ready.` : `${card.key} archived.`); next?.focus(); }
    }
  }

  return (
    <div className="board-wrap">
      <div className="toolbar">
        <label className="search-field">
          <Icon name="search" size={14} />
          <span className="visually-hidden">Filter cards</span>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter cards" />
        </label>
        <div className="chips" role="group" aria-label="Card types">
          {CARD_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={`chip${types.has(t) ? ' on' : ''}`}
              aria-pressed={types.has(t)}
              onClick={() => setTypes((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; })}
            >
              <TypeMark type={t} />{TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        <Select<Priority | 'any'>
          label="Priority"
          size="s"
          value={priority}
          onChange={setPriority}
          options={[{ value: 'any', label: 'Any priority' }, ...PRIORITIES.map((p) => ({ value: p, label: `P${p}`, detail: PRIORITY_MEANING[p] }))]}
        />
        <Select<Agent>
          label="Agent"
          size="s"
          value={agent}
          onChange={setAgent}
          options={[
            { value: 'any', label: 'Any agent' }, { value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' },
            { value: 'shell', label: 'Shell' }, { value: 'none', label: 'No agent on it' },
          ]}
        />
        {filtering ? <button type="button" className="linkish small" onClick={clear}>Clear</button> : null}
        <span className="board-count faint small" aria-live="polite">
          {cards.data ? `${plural(open, 'open card')}${filtering ? ` · ${matching} matching` : ''}` : ''}
        </span>
        <div className="toolbar-end">
          <Select<Sort> label="Order" size="s" value={sort} onChange={setSort} options={SORTS} />
          <button type="button" className="how-btn" onClick={() => setHow(true)}>
            <span className="how-q" aria-hidden="true">?</span>How this works
          </button>
        </div>
      </div>
      {how ? <HowItWorks project={project} cards={cards.data} onClose={() => setHow(false)} showColumn={showColumn} /> : null}

      <JevStrip project={project} />
      <SinceStrip key={project.id} projectId={project.id} cards={cards.data} />
      {cards.error ? <NotAnswering error={cards.error} onRetry={cards.reload} /> : !cards.loading && total === 0 ? (
        <Empty
          title="This board is empty"
          action={<button type="button" className="btn btn-primary btn-m" onClick={() => setDialog({ kind: 'card', projectId: project.id })}><span>New card</span></button>}
        >
          Cards are the work: a task, a bug, a feature or an idea. Start a session on one and the agent takes it. Agents can file cards too; those land in the Inbox.
        </Empty>
      ) : (
        <div className="board" ref={boardRef} aria-busy={cards.loading} onKeyDown={(e) => void onBoardKey(e)}>
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
                onDrop={(e) => void onDrop(e, col)}
              >
                <header className="column-head" title={COLUMN_HINT[col]}>
                  <span className={`col-glyph col-glyph-${col}`} aria-hidden="true" />
                  <h2>{STATUS_LABEL[col]}</h2>
                  <span key={list.length} className={`column-count bump${col === 'review' && list.length ? ' hot' : ''}`}>{list.length}</span>
                  {col === 'working' && held ? (
                    <span className="column-badge" title={`${plural(held, 'card')} held by a session; ${running} with the session running now.`}>
                      {held} held · {running} live
                    </span>
                  ) : null}
                  {col === 'inbox' || col === 'ready' ? (
                    <button type="button" className="column-add" aria-label={`New card in ${STATUS_LABEL[col]}`} title={`New card in ${STATUS_LABEL[col]}`}
                      onClick={() => setDialog({ kind: 'card', projectId: project.id, status: col })}>
                      <Icon name="plus" size={14} />
                    </button>
                  ) : null}
                </header>
                <ol className="column-cards">
                  {shown.map((c, i) => (
                    <li key={c.id} className="card-slot">
                      {drop?.column === col && renderDropIndex === i && drag?.id !== c.id ? <div className="drop-line" aria-hidden="true" /> : null}
                      <CardTile card={c} open={openKey === c.key} dragging={drag?.id === c.id} onDragStart={onDragStart} onDragEnd={() => { setDrag(null); setDrop(null); }} />
                    </li>
                  ))}
                  {drop?.column === col && renderDropIndex >= shown.length ? <li className="card-slot"><div className="drop-line" aria-hidden="true" /></li> : null}
                  {!shown.length && !drop ? <li className="column-empty">{filtering ? 'No matching cards' : COLUMN_EMPTY[col]}</li> : null}
                </ol>
                {col === 'done' && list.length > DONE_SHOWN ? (
                  <button type="button" className="column-more" onClick={() => setAllDone((v) => !v)}>
                    {allDone ? 'Show recent only' : `Show all ${list.length}`}
                  </button>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CardTile({ card, open, dragging, onDragStart, onDragEnd }: {
  card: CardSummary;
  open: boolean;
  dragging: boolean;
  onDragStart: (e: DragEvent, c: CardSummary) => void;
  onDragEnd: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const asking = card.live?.state === 'permission';
  return (
    <article
      ref={ref}
      className={`card${open ? ' open' : ''}${dragging ? ' dragging' : ''}${asking ? ' asking' : ''}`}
      draggable
      tabIndex={0}
      aria-label={`${card.key} ${card.title}`}
      data-key={card.key}
      onDragStart={(e) => onDragStart(e, card)}
      onDragEnd={onDragEnd}
      onClick={() => openCard(card.key)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(card.key); } }}
    >
      <div className="card-head">
        <PriorityBadge priority={card.priority} />
        <TypeMark type={card.type} />
        <span className="card-key mono">{card.key}</span>
        {card.live && card.status !== 'working' ? <StateMark state={card.live.state} label={card.live.state === 'permission'} /> : null}
      </div>
      <p className="card-title">{card.title}</p>
      {card.status === 'working' ? <ClaimLine card={card} /> : null}
      <CardFoot card={card} />
    </article>
  );
}

function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`prio prio-${priority}`} title={`Priority P${priority}: ${PRIORITY_MEANING[priority]}`}>P{priority}</span>;
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
      title={running ? `${session.title || PROVIDER_LABEL[session.provider]}: ${STATE_LABEL[session.state]}. Open its terminal.` : 'The session holding this card is not running. Open it to see how it ended.'}
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

const REVIEW_MARK: Record<NonNullable<CardSummary['aiReview']>, { text: string; tone: string; title: string }> = {
  running: { text: 'AI checking', tone: 'meta', title: 'Claude is checking it against each criterion' },
  pass: { text: 'AI: looks done', tone: 'flag flag-green', title: 'The AI review found proof for every criterion. Approving is still yours.' },
  changes: { text: 'AI: changes', tone: 'flag flag-red', title: 'The AI review found a criterion not met' },
  unsure: { text: 'AI: your call', tone: 'meta', title: 'The AI review could not decide; it needs a person' },
  failed: { text: 'AI: failed', tone: 'meta', title: 'The AI review did not finish' },
};

function CardFoot({ card }: { card: CardSummary }) {
  const bits: ReactElement[] = [];
  if (card.openQuestions) bits.push(<span key="q" className="flag flag-amber" title="An agent asked you something on this card">{card.openQuestions > 1 ? `${card.openQuestions} questions` : 'Question'}</span>);
  if (card.reopened) bits.push(<span key="r" className="flag flag-red">Reopened</span>);
  if (card.sentBack) bits.push(<span key="s" className="flag flag-amber">Sent back</span>);
  if (card.progress.total) {
    const done = card.progress.done === card.progress.total;
    bits.push(<span key="c" className={`meta${done ? ' meta-done' : ''}`} title="Acceptance criteria"><Icon name="check" size={12} />{card.progress.done}/{card.progress.total}</span>);
  }
  if (card.evidenceCount && (card.status === 'review' || card.status === 'done')) {
    bits.push(<span key="e" className="meta" title="Evidence"><Icon name="file" size={12} />{card.evidenceCount}</span>);
  }
  if (card.commentCount) bits.push(<span key="m" className="meta" title="Comments"><Icon name="note" size={12} />{card.commentCount}</span>);
  if (card.claim && !card.live) bits.push(<span key="h" className="meta" title="Claimed, but no live session is attached">held</span>);
  if (card.aiReview && (card.status === 'review' || card.status === 'done')) {
    const m = REVIEW_MARK[card.aiReview];
    bits.push(<span key="a" className={m.tone} title={m.title}>{m.text}</span>);
  }
  if (card.jev) bits.push(<JevChip key="j" card={card} />);
  if (card.status !== 'done') {
    const stuck = Date.now() - card.statusAt > STUCK_MS;
    bits.push(<span key="t" className={`card-age${stuck ? ' stuck' : ''}`} title={`In ${STATUS_LABEL[card.status]} for ${duration(card.statusAt)}`}>{duration(card.statusAt)}</span>);
  }
  return bits.length ? <div className="card-foot">{bits}</div> : null;
}

/** Scroll a column into view and ring its header briefly, for "How this works". */
function showColumn(column: Column): void {
  const el = document.querySelector<HTMLElement>(`.column-${column}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  window.setTimeout(() => el.classList.remove('flash'), 1800);
}


interface BoardView { filter: string; types: CardType[]; sort: Sort; priority: Priority | 'any'; agent: Agent }

function readView(projectId: string): BoardView {
  try {
    const v = JSON.parse(localStorage.getItem(`wanigan.board.${projectId}`) ?? '{}') as Partial<BoardView>;
    return {
      filter: typeof v.filter === 'string' ? v.filter : '',
      types: Array.isArray(v.types) ? v.types.filter((t): t is CardType => (CARD_TYPES as readonly string[]).includes(t)) : [],
      sort: SORTS.some((s) => s.value === v.sort) ? v.sort as Sort : 'manual',
      priority: PRIORITIES.includes(v.priority as Priority) ? v.priority as Priority : 'any',
      agent: v.agent === 'claude' || v.agent === 'codex' || v.agent === 'shell' || v.agent === 'none' ? v.agent : 'any',
    };
  } catch {
    return { filter: '', types: [], sort: 'manual', priority: 'any', agent: 'any' };
  }
}

function writeView(projectId: string, view: BoardView): void {
  try { localStorage.setItem(`wanigan.board.${projectId}`, JSON.stringify(view)); } catch { /* a convenience only */ }
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
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    }
    last.current = now;
  }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps
}
