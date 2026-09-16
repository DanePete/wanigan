import { useMemo } from 'react';
import type { Attention, Project, Session } from '@shared/types';
import type { PresenceRead } from '@shared/companion-presence';
import { sessionName } from '@shared/session-name';
import { EmptyState, Icon, Mark, Note, Reading, SectionHead, ago, markOf } from './bits';
import { useViewMemory } from './viewMemory';

const attentionMark = (kind: Attention['kind']) => kind === 'finished'
  ? { glyph: '◇', word: 'Ready to inspect', tone: 'warn' as const } : markOf(kind);

/** Local operational metadata only. These names/details never enter companion.ask. */
export default function HomeWork({ sessions, attention, read, projects, projectId, onOpenSession, onProject, onNewSession, onFleet }: {
  sessions: Session[]; attention: Attention[]; read: PresenceRead; projects: Project[];
  projectId: string | null; onOpenSession: (id: string) => void; onProject: (id: string) => void;
  onNewSession: () => void; onFleet: () => void;
}) {
  const [selectedId, setSelectedId] = useViewMemory<string | null>('attention-selection', null);
  const scoped = useMemo(() => sessions.filter(session => !projectId || session.projectId === projectId), [sessions, projectId]);
  // Main already ranks severity, then wait. Preserve its order across projects.
  const needs = useMemo(() => attention.flatMap(item => {
    const session = scoped.find(candidate => candidate.id === item.sessionId);
    return session && ['permission', 'error', 'finished'].includes(item.kind) ? [{ session, attention: item }] : [];
  }), [attention, scoped]);
  const selected = needs.find(item => item.session.id === selectedId) ?? needs[0];
  const continuing = scoped.filter(session => !needs.some(item => item.session.id === session.id))
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.createdAt - a.createdAt);
  const visibleProjects = projects.filter(project => !projectId || project.id === projectId);

  return <>
    {read === 'loading' ? <Reading what="session activity" /> : read === 'unavailable'
      ? <Note tone="warn" action={{ label: 'Open fleet', run: onFleet }}>Session status could not refresh. Any work below is from the last available read.</Note> : null}
    {needs.length > 0 ? <section className="home-work" aria-label="Work needing attention">
      <div className="home-work-list">
        <SectionHead label="Needs you" count={needs.length} right={<button className="btn btn-sm" onClick={onFleet}>Open fleet</button>} />
        <div className="home-work-rows">
          {needs.map(({ session, attention: item }) => <button className="home-work-row" type="button" key={session.id}
            aria-pressed={selected?.session.id === session.id} aria-controls="home-work-detail" onClick={() => setSelectedId(session.id)}>
            <span className="home-work-name">{sessionName(session)}</span>
            <span className="home-work-project">{session.projectName}</span>
            <Mark {...attentionMark(item.kind)} />
            <span className="home-work-reason">{item.detail || item.label}</span>
            <span className="home-work-age">{ago(item.since)}</span>
          </button>)}
        </div>
      </div>
      {selected && <section id="home-work-detail" className="home-work-detail" aria-label="Selected work">
        <SectionHead label={selected.session.projectName} />
        <Mark {...attentionMark(selected.attention.kind)} />
        <h2>{sessionName(selected.session)}</h2>
        <p>{selected.attention.detail || selected.attention.label}</p>
        <dl>
          <div><dt>Observed</dt><dd>{ago(selected.attention.since)}</dd></div>
          {selected.attention.tool && <div><dt>Tool</dt><dd>{selected.attention.tool}</dd></div>}
          <div><dt>Workspace</dt><dd>{selected.session.worktree || selected.session.projectPath}</dd></div>
        </dl>
        <button className="btn btn-primary" onClick={() => onOpenSession(selected.session.id)}>
          <Icon name={selected.attention.kind === 'finished' ? 'file-text' : 'terminal'} />
          {selected.attention.kind === 'finished' ? 'Inspect session' : 'Open terminal'}
        </button>
        <p className="home-work-guidance">{selected.attention.kind === 'permission'
          ? 'Decide in the agent’s original permission prompt.'
          : selected.attention.kind === 'finished' ? 'A finished turn still needs its changes and verification reviewed.'
            : 'Read the recorded error and continue from the session.'}</p>
      </section>}
    </section> : read === 'ready' && scoped.length > 0 ? <div className="home-work-clear">
      <Mark glyph="✓" word="No recorded requests for your attention" tone="quiet" />
      <span>Open a session below to see its current output.</span>
    </div> : null}
    {(continuing.length > 0 || (read === 'ready' && projects.length > 0 && !scoped.length)) && <section className="home-continue" aria-label="Continue working">
      <SectionHead label="Continue working" count={continuing.length} />
      {continuing.length ? <div className="home-continue-list">{continuing.slice(0, 6).map(session => {
        const item = attention.find(candidate => candidate.sessionId === session.id);
        return <button className="home-continue-row" key={session.id} onClick={() => onOpenSession(session.id)}>
          <span><strong>{sessionName(session)}</strong><span>{session.projectName}</span></span>
          <span>{read !== 'ready' ? 'Status unavailable' : item?.label ?? (session.status === 'exited' ? 'Session ended' : 'No activity signal')}</span>
          <Icon name="chevron-right" />
        </button>;
      })}</div> : <EmptyState posture="nothing-yet" title="Ready for your next task" cue="Choose a project and start an agent session."
        action={<button className="btn btn-primary" onClick={onNewSession}>New session</button>} />}
      {continuing.length > 6 && <button className="btn btn-sm" onClick={onFleet}>View all {scoped.length} sessions</button>}
    </section>}
    {visibleProjects.length > 0 && <section className="home-projects" aria-label="Your projects">
      <SectionHead label="Your projects" count={visibleProjects.length} />
      <div className="home-project-list">{visibleProjects.map(project => <button key={project.id} className="home-project" onClick={() => onProject(project.id)}>
        <Icon name="reveal" /><span><strong>{project.name}</strong><span>{project.branch ?? 'No branch recorded'}</span></span><Icon name="chevron-right" />
      </button>)}</div>
    </section>}
  </>;
}
