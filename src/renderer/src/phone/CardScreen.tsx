// A card on the phone: what it asks, its criteria, and what its column allows —
// accept or archive from the Inbox, start a session when Ready, approve or send
// back in Review, open the session working on it.
import { useState } from 'react';
import { Markdown } from '../components/Markdown';
import { Button, PriorityMark, TypeMark, useToast } from '../components/ui';
import { attempt, call, useQuery } from '../lib/api';
import { STATUS_LABEL } from '../lib/format';
import { useNav } from './nav';

export function CardScreen({ id }: { id: string }) {
  const nav = useNav();
  const toast = useToast();
  const card = useQuery('cards.get', { id }, ['board']);
  const [note, setNote] = useState<string | null>(null);
  const c = card.data;
  if (!c) return card.error ? <p className="phone-empty">{card.error.message}</p> : null;
  const act = (what: () => Promise<unknown>, said: string) => async (): Promise<void> => {
    if (await attempt(what, (m) => toast(m, 'error'))) { toast(said); card.reload(); }
  };
  const live = c.sessions.find((s) => s.id === c.claim?.sessionId);

  return (
    <article className="phone-card" aria-labelledby="card-title">
      <header className="phone-session-head">
        <Button tone="quiet" icon="back" aria-label="Back" onClick={nav.back} />
        <h1 id="card-title" className="phone-title small"><span className="mono">{c.key}</span> {c.title}</h1>
      </header>
      <p className="faint small"><TypeMark type={c.type} label /> · <PriorityMark priority={c.priority} /> · {STATUS_LABEL[c.status]}</p>
      {c.body ? <Markdown source={c.body} /> : null}
      {c.criteria.length ? (
        <ul className="phone-criteria">
          {c.criteria.map((k) => <li key={k.id} className={k.done ? 'done' : ''}>{k.done ? '✓ ' : '○ '}{k.text}</li>)}
        </ul>
      ) : null}
      <div className="phone-actions">
        {c.status === 'inbox' ? <>
          <Button tone="primary" onClick={act(() => call('cards.move', { id, status: 'ready' }), `${c.key} accepted to Ready.`)}>Accept</Button>
          <Button tone="quiet" onClick={act(() => call('cards.move', { id, status: 'archived' }), `${c.key} archived.`)}>Archive</Button>
        </> : null}
        {(c.status === 'ready' || c.status === 'inbox') && !live ? <Button icon="terminal" onClick={() => nav.go({ name: 'new', projectId: c.projectId, cardId: c.id })}>Start a session on it</Button> : null}
        {live ? <Button icon="terminal" onClick={() => nav.go({ name: 'session', id: live.id })}>Open its session</Button> : null}
        {c.status === 'review' && note === null ? <>
          <Button tone="primary" icon="check" onClick={act(() => call('cards.approve', { id }), `${c.key} approved.`)}>Approve</Button>
          <Button onClick={() => setNote('')}>Send back</Button>
        </> : null}
      </div>
      {note !== null ? (
        <div className="phone-reply">
          <textarea aria-label="What to change" placeholder="What should change?" value={note} onChange={(e) => setNote(e.target.value)} rows={3} autoFocus />
          <div className="phone-actions">
            <Button tone="quiet" onClick={() => setNote(null)}>Cancel</Button>
            <Button tone="primary" disabled={!note.trim()} onClick={act(() => call('cards.sendBack', { id, note: note.trim() }).then(() => setNote(null)), `${c.key} sent back.`)}>Send back</Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
