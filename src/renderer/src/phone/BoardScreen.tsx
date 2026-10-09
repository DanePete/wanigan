// One project's board on a phone: a column at a time, its cards, and a new card.
import { useState, type FormEvent } from 'react';
import { CARD_TYPES, COLUMNS, type CardType } from '@shared/model';
import { Button, PriorityMark, Segmented, StateMark, TypeMark, useToast } from '../components/ui';
import { attempt, call, useQuery } from '../lib/api';
import { STATUS_LABEL, TYPE_LABEL } from '../lib/format';
import { useNav } from './nav';

type Column = (typeof COLUMNS)[number];

export function BoardScreen({ projectId }: { projectId: string }) {
  const nav = useNav();
  const projects = useQuery('projects.list', {}, ['projects']);
  const cards = useQuery('cards.list', { projectId }, ['board']);
  const [column, setColumn] = useState<Column>('ready');
  const [adding, setAdding] = useState(false);
  const project = projects.data?.find((p) => p.id === projectId);
  const shown = (cards.data ?? []).filter((c) => c.status === column);
  return (
    <section aria-labelledby="board-title">
      <header className="phone-session-head">
        <Button tone="quiet" icon="back" aria-label="Back" onClick={nav.back} />
        <h1 id="board-title" className="phone-title small">{project?.name ?? 'Board'}</h1>
      </header>
      <Segmented<Column> label="Column" size="s" value={column} onChange={setColumn}
        options={COLUMNS.map((c) => ({ value: c, label: `${STATUS_LABEL[c]} ${(cards.data ?? []).filter((x) => x.status === c).length}` }))} />
      {adding ? <NewCard projectId={projectId} onDone={() => setAdding(false)} /> : <Button icon="plus" onClick={() => setAdding(true)}>New card</Button>}
      {cards.data && !shown.length ? <p className="phone-empty">No cards in {STATUS_LABEL[column]}.</p> : null}
      <ol className="phone-list">
        {shown.map((c) => (
          <li key={c.id}>
            <button type="button" className="phone-item phone-row" onClick={() => nav.go({ name: 'card', id: c.id })}>
              <TypeMark type={c.type} />
              <span className="phone-row-main">
                <span className="phone-item-title"><span className="mono">{c.key}</span> {c.title}</span>
                <span className="faint small"><PriorityMark priority={c.priority} />{c.progress.total ? ` · ${c.progress.done}/${c.progress.total}` : ''}{c.openQuestions ? ' · a question' : ''}</span>
              </span>
              {c.live ? <StateMark state={c.live.state} label={false} /> : null}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function NewCard({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<CardType>('task');
  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const card = await attempt(() => call('cards.create', { projectId, title: title.trim(), type }), (m) => toast(m, 'error'));
    if (card) { toast(`${card.key} is in the Inbox.`); onDone(); }
  };
  return (
    <form className="phone-form phone-new-card" onSubmit={(e) => void create(e)}>
      <label><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus required /></label>
      <Segmented<CardType> label="Type" size="s" value={type} onChange={setType} options={CARD_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
      <div className="phone-actions">
        <Button tone="quiet" onClick={onDone}>Cancel</Button>
        <Button type="submit" tone="primary" disabled={!title.trim()}>Add to Inbox</Button>
      </div>
    </form>
  );
}
