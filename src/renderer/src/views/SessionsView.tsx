import type { ProjectSummary, Session } from '@shared/model';
import { bridge, forProject, useQuery } from '../lib/api';
import { shortcutFor } from '@shared/shortcuts';
import { href } from '../lib/router';
import { PROVIDER_LABEL, ago, duration } from '../lib/format';
import { Button, Empty, KeyCaps, NotAnswering, StateMark } from '../components/ui';
import type { DialogState } from '../App';

/** One session in a list. In a card's own list (`inCard`) the card is not repeated. */
export function SessionRow({ session, projectKey, inCard = false }: { session: Session; projectKey: string; inCard?: boolean }) {
  const cardKey = session.cardKey;
  const live = session.endedAt === null;
  return (
    <a className={`srow${live ? ' live' : ''}`} href={href({ name: 'session', projectKey, sessionId: session.id })}>
      <StateMark state={session.state} label={false} />
      <span className="srow-main">
        <span className="srow-title">{session.title}</span>
        <span className="srow-activity">{session.activity ?? ''}</span>
      </span>
      <span className="srow-meta">
        {inCard ? null : cardKey ? <span className="mono">{cardKey}</span> : <span className="faint">One-off</span>}
        <span>{PROVIDER_LABEL[session.provider]}</span>
        <span className="faint">{live ? duration(session.startedAt) : ago(session.endedAt)}</span>
      </span>
    </a>
  );
}

export function SessionsView({ project, setDialog }: { project: ProjectSummary; setDialog: (d: DialogState) => void }) {
  const sessions = useQuery('sessions.list', { projectId: project.id }, ['sessions'], forProject(project.id));
  const live = (sessions.data ?? []).filter((s) => s.endedAt === null);
  const past = (sessions.data ?? []).filter((s) => s.endedAt !== null);
  if (sessions.error) return <NotAnswering error={sessions.error} onRetry={sessions.reload} />;
  if (sessions.data && !sessions.data.length) {
    return (
      <Empty title="No sessions yet" action={<Button tone="primary" icon="terminal" onClick={() => setDialog({ kind: 'session', projectId: project.id })}>New session</Button>}>
        A session is a real terminal running Claude Code, Codex or your shell in {project.path}. Start one on a card, or on its own for quick work.
      </Empty>
    );
  }
  return (
    <div className="view-pad sessions-page">
      <h2 className="section-title">Live <span className="faint">{live.length}</span></h2>
      {live.length ? <div className="srows">{live.map((s) => <SessionRow key={s.id} session={s} projectKey={project.key} />)}</div>
        : <p className="faint">Nothing running. Sessions keep running when you close the window.</p>}
      {past.length ? (
        <>
          <h2 className="section-title">Earlier <span className="faint">{past.length}</span></h2>
          <div className="srows">{past.slice(0, 50).map((s) => <SessionRow key={s.id} session={s} projectKey={project.key} />)}</div>
        </>
      ) : null}
      <p className="faint small sessions-more">
        Every conversation in this folder, including ones from VS Code and other terminals, is in{' '}
        <a href={href({ name: 'project', projectKey: project.key, view: 'history' })}>History</a> <KeyCaps shortcut={shortcutFor('history')!} mac={bridge().platform === 'darwin'} />
      </p>
    </div>
  );
}
