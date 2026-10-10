import { useMemo, useState } from 'react';
import type { CardSummary, ProjectSummary } from '@shared/model';
import { forProject, useQuery } from '../lib/api';
import { openCard } from '../lib/router';
import { ago } from '../lib/format';
import { Icon } from '../components/icons';
import { Empty, NotAnswering, PriorityMark, StateMark, TypeMark } from '../components/ui';

type SortKey = 'key' | 'title' | 'status' | 'priority' | 'updated';
const STATUS_ORDER = { inbox: 0, ready: 1, working: 2, review: 3, done: 4, archived: 5 } as const;

export function ListView({ project }: { project: ProjectSummary }) {
  const cards = useQuery('cards.list', { projectId: project.id }, ['board', 'sessions'], forProject(project.id));
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'status', dir: 1 });
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (cards.data ?? []).filter((c) => !q || `${c.key} ${c.title}`.toLowerCase().includes(q));
    const value = (c: CardSummary): number | string => {
      switch (sort.key) {
        case 'key': return Number(c.key.split('-')[1]);
        case 'title': return c.title.toLowerCase();
        case 'status': return STATUS_ORDER[c.status] * 10 + c.priority;
        case 'priority': return c.priority;
        case 'updated': return -c.updatedAt;
      }
    };
    return [...list].sort((a, b) => (value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0) * sort.dir);
  }, [cards.data, sort, filter]);

  if (cards.error) return <NotAnswering error={cards.error} onRetry={cards.reload} />;
  const head = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
        {label}{sort.key === key ? <span aria-hidden="true">{sort.dir === 1 ? ' ↑' : ' ↓'}</span> : null}
      </button>
    </th>
  );

  return (
    <div className="list-wrap">
      <div className="toolbar">
        <label className="search-field">
          <Icon name="search" size={14} />
          <span className="visually-hidden">Filter cards</span>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter cards" />
        </label>
        <span className="toolbar-end faint">{rows.length} of {cards.data?.length ?? 0}</span>
      </div>
      {cards.data && !cards.data.length ? <Empty title="No cards yet">New cards appear here as a sortable table.</Empty> : (
        <table className="table">
          <thead>
            <tr>
              {head('key', 'Key')}
              <th scope="col">Type</th>
              {head('title', 'Title')}
              {head('status', 'Status')}
              {head('priority', 'Priority')}
              <th scope="col">Criteria</th>
              <th scope="col">Session</th>
              {head('updated', 'Updated')}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} onClick={() => openCard(c.key)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') openCard(c.key); }}>
                <td className="mono faint">{c.key}</td>
                <td><TypeMark type={c.type} label /></td>
                <td className="table-title">{c.title}</td>
                <td><span className={`status status-${c.status}`}>{c.status}</span></td>
                <td><PriorityMark priority={c.priority} /></td>
                <td className="faint">{c.progress.total ? `${c.progress.done}/${c.progress.total}` : ''}</td>
                <td>{c.live ? <StateMark state={c.live.state} /> : null}</td>
                <td className="faint">{ago(c.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
