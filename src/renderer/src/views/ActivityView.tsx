import { useMemo } from 'react';
import type { ProjectSummary } from '@shared/model';
import { forProject, useQuery } from '../lib/api';
import { openCard } from '../lib/router';
import { actorName } from '../lib/format';
import { Empty, NotAnswering } from '../components/ui';

export function ActivityView({ project }: { project: ProjectSummary }) {
  // A save in the code editor is activity too ("You edited …").
  const activity = useQuery('activity.list', { projectId: project.id, limit: 300 }, ['board', 'sessions', 'decisions', 'projects', 'files'], forProject(project.id));
  const sessions = useQuery('sessions.list', { projectId: project.id }, ['sessions'], forProject(project.id));
  const cards = useQuery('cards.list', { projectId: project.id }, ['board'], forProject(project.id));
  const sessionMap = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.id, s])), [sessions.data]);
  const cardMap = useMemo(() => new Map((cards.data ?? []).map((c) => [c.id, c])), [cards.data]);
  const days = useMemo(() => {
    const groups: { day: string; items: NonNullable<typeof activity.data> }[] = [];
    for (const a of activity.data ?? []) {
      const day = new Date(a.at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      const last = groups.at(-1);
      if (last?.day === day) last.items.push(a); else groups.push({ day, items: [a] });
    }
    return groups;
  }, [activity.data]);
  if (activity.error) return <NotAnswering error={activity.error} onRetry={activity.reload} />;
  if (activity.data && !activity.data.length) return <Empty title="Nothing has happened here yet">Everything you and your agents do in this project is recorded here.</Empty>;
  return (
    <div className="view-pad activity">
      {days.map((g) => (
        <section key={g.day} className="activity-day">
          <h2 className="section-title">{g.day}</h2>
          <ol>
            {g.items.map((a) => {
              const card = a.cardId ? cardMap.get(a.cardId) : undefined;
              return (
                <li key={a.id} className="activity-item">
                  <time className="faint" dateTime={new Date(a.at).toISOString()}>{new Date(a.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
                  <span className="activity-text">
                    <strong>{actorName(a.actor, sessionMap)}</strong> {a.verb}
                    {card ? <> <button type="button" className="linkish mono" onClick={() => openCard(card.key)}>{card.key}</button></> : null}
                    {a.detail ? <span className="activity-detail"> {a.detail}</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
