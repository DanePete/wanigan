// A project's Activity: everything you and your agents did here, newest
// first, by day: the core's own log (board.log), which a save in the code
// editor, a commit, a push and a card's moves all write to. The list is the
// work; the chosen entry is read in full in the reader panel beside it, with
// its card and its session a click away. Who did it, and words in it, narrow
// the list.
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Activity, ProjectSummary } from '@shared/model';
import { forProject, useQuery } from '../lib/api';
import { href, openCard } from '../lib/router';
import { actorName, ago, plural } from '../lib/format';
import { Icon } from '../components/icons';
import { Panel, Section } from '../components/Panel';
import { Toolbar } from '../components/Toolbar';
import { Button, EmptyState, NotAnswering, Segmented } from '../components/ui';
import { CardBadge } from './git/common';
import '../styles/records.css';

type Who = 'all' | 'you' | 'agents';
const whoOf = (a: Activity): Who => (a.actor === 'owner' || a.actor.startsWith('phone:') ? 'you' : a.actor.startsWith('session:') ? 'agents' : 'all');
const LIMIT = 300;

export function ActivityView({ project }: { project: ProjectSummary }) {
  // A save in the code editor is activity too ("You edited …").
  const activity = useQuery('activity.list', { projectId: project.id, limit: LIMIT }, ['board', 'sessions', 'decisions', 'projects', 'files'], forProject(project.id));
  const sessions = useQuery('sessions.list', { projectId: project.id }, ['sessions'], forProject(project.id));
  const cards = useQuery('cards.list', { projectId: project.id }, ['board'], forProject(project.id));
  const sessionMap = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.id, s])), [sessions.data]);
  const cardMap = useMemo(() => new Map((cards.data ?? []).map((c) => [c.id, c])), [cards.data]);
  const [who, setWho] = useState<Who>('all');
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<number | null>(null);
  const [reader, setReader] = useState(true);
  const list = useRef<HTMLDivElement>(null);

  const q = filter.trim().toLowerCase();
  const all = useMemo(() => activity.data ?? [], [activity.data]);
  const shown = useMemo(() => all.filter((a) => (who === 'all' || whoOf(a) === who)
    && (!q || `${actorName(a.actor, sessionMap)} ${a.verb} ${a.detail ?? ''} ${a.cardId ? cardMap.get(a.cardId)?.key ?? '' : ''}`.toLowerCase().includes(q))), [all, who, q, sessionMap, cardMap]);
  const days = useMemo(() => {
    const groups: { day: string; items: Activity[] }[] = [];
    for (const a of shown) {
      const day = new Date(a.at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      const last = groups.at(-1);
      if (last?.day === day) last.items.push(a); else groups.push({ day, items: [a] });
    }
    return groups;
  }, [shown]);
  const current = shown.find((a) => a.id === chosen) ?? shown[0] ?? null;

  const choose = (a: Activity | undefined, focus = false): void => {
    if (!a) return;
    setChosen(a.id);
    setReader(true);
    if (focus) requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-id="${a.id}"]`)?.focus());
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const at = current ? shown.indexOf(current) : -1;
    const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
    if (step) { e.preventDefault(); choose(shown[Math.max(0, Math.min(shown.length - 1, at + step))], true); }
    else if (e.key === 'Home') { e.preventDefault(); choose(shown[0], true); }
    else if (e.key === 'End') { e.preventDefault(); choose(shown.at(-1), true); }
  };

  if (activity.error) return <NotAnswering error={activity.error} onRetry={activity.reload} />;
  if (activity.data && !activity.data.length) {
    return <EmptyState icon="activity" title="Nothing has happened here yet">Everything you and your agents do in this project is recorded here.</EmptyState>;
  }
  const time = (a: Activity): string => new Date(a.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const card = current?.cardId ? cardMap.get(current.cardId) : undefined;
  const session = current?.sessionId ? sessionMap.get(current.sessionId) : current?.actor.startsWith('session:') ? sessionMap.get(current.actor.slice(8)) : undefined;
  return (
    <div className="records">
      <Toolbar label="Activity" className="records-toolbar">
        <span data-tour="activity-filter" className="records-filters">
          <Segmented size="s" label="Who did it" value={who} onChange={setWho} options={[
            { value: 'all', label: 'Everyone' },
            { value: 'you', label: 'You', hint: 'What you did, here or from your phone' },
            { value: 'agents', label: 'Agents', hint: 'What the sessions in this project did' },
          ]} />
          <label className="search-field records-filter">
            <Icon name="search" size={14} />
            <span className="visually-hidden">Filter the activity by its words</span>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Words, a file, a card" spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.stopPropagation(); setFilter(''); } }} />
          </label>
        </span>
        <span className="records-count" role="status">
          {activity.data ? (shown.length === all.length ? `The latest ${plural(all.length, 'entry', 'entries')}` : `${shown.length} of the latest ${all.length}`) : ''}
        </span>
      </Toolbar>
      <div className="records-body">
        <div className="records-work" ref={list} onKeyDown={onKey}>
          {!activity.data ? <p className="records-wait">Reading the activity…</p> : !shown.length ? (
            <EmptyState title="Nothing matches">{q ? `No entry holds “${filter.trim()}”${who !== 'all' ? ' among those shown' : ''}.` : 'Nothing here was done by them yet.'}</EmptyState>
          ) : (
            <div className="records-list activity" data-tour="activity-list">
              {days.map((g) => (
                <section key={g.day} className="activity-day" aria-label={g.day}>
                  <h2 className="records-day">{g.day}</h2>
                  <ol>
                    {g.items.map((a) => {
                      const c = a.cardId ? cardMap.get(a.cardId) : undefined;
                      return (
                        <li key={a.id} className={`activity-item record${a.id === current?.id ? ' on' : ''}`}>
                          <button type="button" className="record-hit" data-id={a.id}
                            aria-current={a.id === current?.id ? 'true' : undefined} tabIndex={a.id === current?.id ? 0 : -1} onClick={() => choose(a)}>
                            <time className="record-time" dateTime={new Date(a.at).toISOString()}>{time(a)}</time>
                            <span className="activity-text">
                              <strong>{actorName(a.actor, sessionMap)}</strong> {a.verb}
                              {a.detail ? <span className="activity-detail"> {a.detail}</span> : null}
                            </span>
                          </button>
                          {c ? <CardBadge cardKey={c.key} tip={`Open ${c.key}: ${c.title}`} /> : null}
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </div>
        {current ? (
          <Panel side="right" open={reader} onClose={() => setReader(false)} className="records-reader" label="The entry" title="Entry"
            resizable sizeKey="activity-reader" size={380} minSize={292} maxSize={600}>
            <div data-tour="activity-reader">
              <h3 className="reader-title"><strong>{actorName(current.actor, sessionMap)}</strong> {current.verb}</h3>
              <p className="reader-fact">
                <time dateTime={new Date(current.at).toISOString()}>{new Date(current.at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}</time>
                {' · '}{ago(current.at)}
              </p>
              {current.detail ? (
                <Section title="Detail"><p className="reader-body reader-detail">{current.detail}</p></Section>
              ) : null}
              {card ? (
                <Section title="Card">
                  <p className="reader-fact"><span className="mono">{card.key}</span> {card.title}</p>
                  <div className="reader-acts"><Button size="s" icon="open" onClick={() => openCard(card.key)}>Open the card</Button></div>
                </Section>
              ) : null}
              {session ? (
                <Section title="Session">
                  <p className="reader-fact">{session.title}</p>
                  <div className="reader-acts">
                    <a className="btn btn-plain btn-s" href={href({ name: 'session', projectKey: project.key, sessionId: session.id })}>
                      <Icon name="terminal" size={14} /><span>Open the session</span>
                    </a>
                  </div>
                </Section>
              ) : null}
            </div>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
