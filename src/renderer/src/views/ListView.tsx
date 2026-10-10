// The List: the board's other mode (Studio). The same toolbar, filters and saved
// views as the board, over every card in one dense table, archived ones too: its
// head stays at the top, the columns sort, and the keys walk the rows (J/K or the
// arrows, Home and End, Enter to open; A and X on an Inbox card, as on the board).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CardSummary, ProjectSummary } from '@shared/model';
import { attempt, call, forProject, useQuery } from '../lib/api';
import { openCard, useLocation } from '../lib/router';
import { STATUS_LABEL, ago } from '../lib/format';
import { Button, EmptyState, NotAnswering, StateMark, TypeMark, tipProps, useToast } from '../components/ui';
import type { DialogState } from '../App';
import { BoardToolbar, CardCount, PriorityBadge, useBoardView } from './Board';

type SortKey = 'key' | 'title' | 'status' | 'priority' | 'updated';
type Sort = { key: SortKey; dir: 1 | -1 };
const STATUS_ORDER = { inbox: 0, ready: 1, working: 2, review: 3, done: 4, archived: 5 } as const;
const SORT_KEYS: readonly SortKey[] = ['key', 'title', 'status', 'priority', 'updated'];

/** Rows a Page Up or Page Down moves by. */
const PAGE = 10;

export function ListView({ project, setDialog }: { project: ProjectSummary; setDialog?: (d: DialogState) => void }) {
  const cards = useQuery('cards.list', { projectId: project.id }, ['board', 'sessions'], forProject(project.id));
  const board = useBoardView(project.id);
  const toast = useToast();
  const { card: openKey } = useLocation();
  const [sort, setSort] = useState<Sort>(() => readSort(project.id));
  useEffect(() => { writeSort(project.id, sort); }, [project.id, sort]);
  const [active, setActive] = useState<string | null>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  const lastG = useRef(0);

  const rows = useMemo(() => {
    const list = (cards.data ?? []).filter(board.matches);
    const value = (c: CardSummary): number | string => {
      switch (sort.key) {
        case 'key': return Number(c.key.split('-')[1]);
        case 'title': return c.title.toLowerCase();
        case 'status': return (STATUS_ORDER[c.status] ?? 9) * 10 + c.priority;
        case 'priority': return c.priority;
        case 'updated': return -c.updatedAt;
      }
    };
    return [...list].sort((a, b) => (value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0) * sort.dir);
  }, [cards.data, board.matches, sort]);

  // One row takes Tab: the last one walked to, else the open card's, else the first.
  const stop = rows.some((c) => c.key === active) ? active : rows.some((c) => c.key === openKey) ? openKey : rows[0]?.key ?? null;

  const focusRow = (i: number): void => {
    const list = [...(body.current?.querySelectorAll<HTMLElement>('tr[data-key]') ?? [])];
    const el = list[Math.max(0, Math.min(i, list.length - 1))];
    if (!el) return;
    setActive(el.dataset.key ?? null);
    el.focus();
    el.scrollIntoView({ block: 'nearest' });
  };

  const onKey = async (e: KeyboardEvent<HTMLTableSectionElement>): Promise<void> => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('tr[data-key]');
    if (!row || e.target !== row || e.metaKey || e.ctrlKey || e.altKey) return;
    // G starts the app's two-key jumps (G then B is the board): the key after it is the app's.
    if (e.key === 'g') { lastG.current = Date.now(); return; }
    if (Date.now() - lastG.current < 1200) { lastG.current = 0; return; }
    const at = rows.findIndex((c) => c.key === row.dataset.key);
    const key = e.key.toLowerCase();
    const go = (i: number): void => { e.preventDefault(); focusRow(i); };
    if (key === 'j' || e.key === 'ArrowDown') go(at + 1);
    else if (key === 'k' || e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if (e.key === 'PageDown') go(at + PAGE);
    else if (e.key === 'PageUp') go(at - PAGE);
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(row.dataset.key ?? null); }
    else if ((key === 'a' || key === 'x') && rows[at]?.status === 'inbox') {
      e.preventDefault();
      e.stopPropagation();
      const card = rows[at] as CardSummary;
      const done = await attempt(() => call('cards.move', { id: card.id, status: key === 'a' ? 'ready' : 'archived' }), (m) => toast(m, 'error'));
      if (done) { toast(key === 'a' ? `${card.key} accepted to Ready.` : `${card.key} archived.`); focusRow(at); }
    }
  };

  const head = (key: SortKey, label: string, tip?: string) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" {...(tip ? tipProps(tip) : {})} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
        {label}{sort.key === key ? <span aria-hidden="true">{sort.dir === 1 ? '↑' : '↓'}</span> : null}
      </button>
    </th>
  );

  const total = cards.data?.length ?? 0;
  return (
    <div className="list-view">
      <BoardToolbar project={project} mode="list" board={board} setDialog={setDialog} />
      <div className="list-scroll">
        {cards.error ? <NotAnswering error={cards.error} onRetry={cards.reload} /> : cards.data && !total ? (
          <EmptyState icon="list" title="No cards yet"
            action={setDialog ? <Button tone="primary" icon="plus" onClick={() => setDialog({ kind: 'card', projectId: project.id })}>New card</Button> : undefined}>
            Every card you and the agents file is listed here, archived ones too.
          </EmptyState>
        ) : cards.data && !rows.length ? (
          <EmptyState title="No cards match" action={<Button onClick={board.clear}>Clear the filters</Button>}>
            Nothing on this board has those words, types, priority and agent together.
          </EmptyState>
        ) : (
          <table className="list-table" data-tour="list-table" aria-label={`${project.name}: every card`} aria-busy={cards.loading}>
            <thead data-tour="list-head">
              <tr>
                {head('key', 'Key')}
                <th scope="col"><span>Type</span></th>
                {head('title', 'Title')}
                {head('status', 'Status', 'By status, then priority')}
                {head('priority', 'Priority')}
                <th scope="col"><span>Criteria</span></th>
                <th scope="col"><span>Session</span></th>
                {head('updated', 'Updated', 'Most recently changed first')}
              </tr>
            </thead>
            <tbody ref={body} onKeyDown={(e) => void onKey(e)}>
              {!cards.data ? Array.from({ length: 6 }, (_, i) => (
                <tr key={i} className="list-skeleton" aria-hidden="true">{Array.from({ length: 8 }, (__, j) => <td key={j}><span /></td>)}</tr>
              )) : rows.map((c) => (
                <tr
                  key={c.id}
                  data-key={c.key}
                  tabIndex={c.key === stop ? 0 : -1}
                  data-tour={c.key === stop ? 'list-row' : undefined}
                  className={c.status === 'archived' ? 'list-archived' : undefined}
                  aria-current={openKey === c.key ? 'true' : undefined}
                  onFocus={() => setActive(c.key)}
                  onClick={() => openCard(c.key)}
                >
                  <td className="list-key">{c.key}</td>
                  <td><TypeMark type={c.type} label /></td>
                  <td className="list-title">
                    <span className="list-title-text">{c.title}</span>
                    {c.openQuestions ? <span className="flag flag-amber list-flags">{c.openQuestions > 1 ? `${c.openQuestions} questions` : 'Question'}</span> : null}
                    {c.reopened ? <span className="flag flag-red list-flags">Reopened</span> : null}
                  </td>
                  <td>
                    <span className={`list-status list-status-${c.status}`}>
                      <span className={`col-glyph col-glyph-${c.status}`} aria-hidden="true" />{STATUS_LABEL[c.status] ?? c.status}
                    </span>
                  </td>
                  <td><PriorityBadge priority={c.priority} /></td>
                  <td>
                    {c.progress.total ? (
                      <span className={`list-num${c.progress.done === c.progress.total ? ' list-num-done' : ''}`}
                        {...tipProps(`${c.progress.done} of ${c.progress.total} criteria met`)}>{c.progress.done}/{c.progress.total}</span>
                    ) : null}
                  </td>
                  <td>{c.live ? <StateMark state={c.live.state} /> : null}</td>
                  <td className="list-num">{ago(c.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <CardCount cards={cards.data} matching={rows.length} filtering={board.filtering} noun="card" />
    </div>
  );
}

/** How the List was last sorted on this board (a convenience in this window). */
function readSort(projectId: string): Sort {
  try {
    const raw = JSON.parse(localStorage.getItem(`wanigan.list.${projectId}`) ?? 'null') as Partial<Sort> | null;
    if (raw && SORT_KEYS.includes(raw.key as SortKey) && (raw.dir === 1 || raw.dir === -1)) return { key: raw.key as SortKey, dir: raw.dir };
  } catch { /* fall through */ }
  return { key: 'status', dir: 1 };
}

function writeSort(projectId: string, sort: Sort): void {
  try { localStorage.setItem(`wanigan.list.${projectId}`, JSON.stringify(sort)); } catch { /* a convenience only */ }
}
