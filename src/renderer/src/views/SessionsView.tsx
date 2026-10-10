// A project's Sessions: what is running here and what ran, as rows that open
// the session. One toolbar (filter, History, New session); explanation lives in
// the empty state and the tooltips.
import { useMemo, useState } from 'react';
import type { ProjectSummary, Session } from '@shared/model';
import { forProject, useQuery } from '../lib/api';
import { href, navigate } from '../lib/router';
import { PROVIDER_LABEL, ago, duration, plural } from '../lib/format';
import { Icon } from '../components/icons';
import { Button, Count, EmptyState, NotAnswering, StateMark, tipProps } from '../components/ui';
import { Section } from '../components/Panel';
import { Toolbar } from '../components/Toolbar';
import type { DialogState } from '../App';

/** The most ended sessions a project's list shows; every conversation is in History. */
const EARLIER_MAX = 50;

/** One session in a list. In a card's own list (`inCard`) the card is not repeated. */
export function SessionRow({ session, projectKey, inCard = false }: { session: Session; projectKey: string; inCard?: boolean }) {
  const cardKey = session.cardKey;
  const live = session.endedAt === null;
  return (
    <a className={`srow${live ? ' srow-live' : ''}`} href={href({ name: 'session', projectKey, sessionId: session.id })}>
      <StateMark state={session.state} label={false} />
      <span className="srow-main">
        <span className="srow-title">{session.title}</span>
        <span className="srow-activity">{session.activity ?? ''}</span>
      </span>
      <span className="srow-meta">
        {inCard ? null : cardKey ? <span className="mono">{cardKey}</span> : <span className="faint">One-off</span>}
        <span>{PROVIDER_LABEL[session.provider]}</span>
        <span className="srow-when">{live ? duration(session.startedAt) : ago(session.endedAt)}</span>
      </span>
    </a>
  );
}

export function SessionsView({ project, setDialog }: { project: ProjectSummary; setDialog: (d: DialogState) => void }) {
  const sessions = useQuery('sessions.list', { projectId: project.id }, ['sessions'], forProject(project.id));
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase();
    const all = sessions.data ?? [];
    if (!words) return all;
    return all.filter((s) => [s.title, s.activity ?? '', s.cardKey ?? '', PROVIDER_LABEL[s.provider]].join(' ').toLowerCase().includes(words));
  }, [sessions.data, filter]);
  const live = shown.filter((s) => s.endedAt === null);
  const past = shown.filter((s) => s.endedAt !== null);
  const newSession = (): void => setDialog({ kind: 'session', projectId: project.id });
  const paused = !!project.pausedAt;

  if (sessions.error) return <NotAnswering error={sessions.error} onRetry={sessions.reload} />;
  if (sessions.data && !sessions.data.length) {
    return (
      <EmptyState title="No sessions yet" icon="terminal" action={<Button tone="primary" icon="terminal" keys="new-session" disabled={paused} onClick={newSession}>New session</Button>}>
        A session is a real terminal running Claude Code, Codex, Gemini CLI or your shell in this project. Start one on a card, or on its own for quick work.
      </EmptyState>
    );
  }
  return (
    <div className="sessions-view">
      <Toolbar label="Sessions">
        <label className="search-field">
          <Icon name="search" size={14} />
          <span className="visually-hidden">Filter sessions</span>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by title, card or agent"
            onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.stopPropagation(); setFilter(''); } }} />
        </label>
        <span className="toolbar-count" aria-live="polite">
          {sessions.data ? (filter.trim() ? plural(shown.length, 'match', 'matches') : `${live.length} live · ${past.length} ended`) : ''}
        </span>
        <span className="toolbar-gap" />
        <Button size="s" tone="quiet" icon="history" onClick={() => navigate({ name: 'project', projectKey: project.key, view: 'history' })}
          {...tipProps('Every conversation in this folder, from here, VS Code and other terminals', 'history')}>History</Button>
        <Button size="s" tone="primary" icon="terminal" keys="new-session" disabled={paused} onClick={newSession}>New session</Button>
      </Toolbar>
      <div className="sessions-list">
        {!sessions.data ? null : (
          <>
            <Section title={<>Live <Count n={live.length} /></>}>
              {live.length ? <div className="srows">{live.map((s) => <SessionRow key={s.id} session={s} projectKey={project.key} />)}</div>
                : <p className="sessions-none">{filter.trim() ? 'Nothing running matches.' : 'Nothing running here.'}</p>}
            </Section>
            {past.length ? (
              <Section title={<>Earlier <Count n={past.length} /></>}>
                <div className="srows">{past.slice(0, EARLIER_MAX).map((s) => <SessionRow key={s.id} session={s} projectKey={project.key} />)}</div>
                {past.length > EARLIER_MAX ? <p className="sessions-none">The newest {EARLIER_MAX} are shown. History has every conversation.</p> : null}
              </Section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
