import { useEffect, useMemo, useRef, useState } from 'react';
import type { CardSummary, ProjectSummary, Session } from '@shared/model';
import { attempt, bridge, call, forProject, useQuery } from '../lib/api';
import { shortcutFor } from '@shared/shortcuts';
import { LIVE_VIEW, PROJECT_VIEWS, href, navigate, openCard, type ProjectView as View } from '../lib/router';
import { LivePane } from '../components/Live';
import { PROVIDER_LABEL, actorName, ago, duration, fileManager, plural } from '../lib/format';
import { Icon } from '../components/icons';
import { MenuButton, type MenuItem } from '../components/Menu';
import { NavTabs } from '../components/Tabs';
import { Button, Empty, KeyCaps, NotAnswering, PriorityMark, StateMark, TypeMark, useSingleFlight, useToast } from '../components/ui';
import { PauseDialog, ProjectSettingsDialog } from '../dialogs/ProjectDialogs';
import { Board } from './Board';
import { ChangesView } from './ChangesView';
import { HistoryView } from './HistoryView';
import type { DialogState } from '../App';

/** The views the bar shows as tabs, in order; the rest are under ··· (and in the palette, by G then their key). */
const TABBED: readonly View[] = ['board', 'sessions', 'changes', 'code'];
const MORE: readonly View[] = ['history', 'decisions', 'activity', 'list'];

/**
 * Where the tabs scroll (a narrow view: shell.css), the tab shown stays in view: when it changes, and when the
 * strip is resized (the window, the dock beside the view). Only the strip scrolls, never the view.
 */
function useShownTabInView(view: View) {
  const strip = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = strip.current;
    if (!el) return undefined;
    const reveal = (): void => {
      const tab = el.querySelector<HTMLElement>('[aria-current="page"], .active');
      if (!tab || el.scrollWidth <= el.clientWidth) return;
      const left = tab.offsetLeft - el.offsetLeft;
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (left + tab.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = left + tab.offsetWidth - el.clientWidth;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);
  return strip;
}

/**
 * The project bar (48 px): the project's name, a menu (switch, its settings, its folder); its views as pill tabs,
 * the rest under ···; and on the right what its agents are doing and Pause. It narrows with the window and the dock
 * beside the view: the words beside the mark and Pause give way first, then the tabs scroll in their own strip.
 */
export function ProjectView({ project, projects, view, setDialog }: { project: ProjectSummary; projects: readonly ProjectSummary[]; view: View; setDialog: (d: DialogState) => void }) {
  const toast = useToast();
  const [pausing, setPausing] = useState(false);
  const [settings, setSettings] = useState(false);
  const resume = (): Promise<void> => attempt(() => call('projects.resume', { id: project.id }), (m) => toast(m, 'error'))
    .then((r) => { if (r) toast(`${project.name} resumed.`, 'done'); });
  const tabs = useShownTabInView(view);
  const to = (v: View): string => href({ name: 'project', projectKey: project.key, view: v });
  const label = (v: View): string => (v === LIVE_VIEW.view ? LIVE_VIEW.label : PROJECT_VIEWS.find((x) => x.view === v)?.label ?? v);
  const keyOf = (v: View): string | undefined => PROJECT_VIEWS.find((x) => x.view === v)?.key.toUpperCase();
  const inMore = MORE.includes(view);

  const nameMenu: MenuItem[] = [
    ...projects.map((p, i): MenuItem => ({
      id: `switch-${p.id}`, group: 'Projects', label: p.name, kind: 'radio', checked: p.id === project.id,
      ...(i < 9 ? { keys: ['Mod', String(i + 1)] } : {}),
      run: () => navigate({ name: 'project', projectKey: p.key, view: p.id === project.id ? view : 'board' }),
    })),
    { id: 'project-settings', group: project.name, label: 'Project settings…', icon: 'settings', run: () => setSettings(true) },
    { id: 'show-folder', group: project.name, label: `Show in ${fileManager(bridge().platform)}`, icon: 'folder', disabled: !project.pathOk,
      run: () => void bridge().openPath(project.path) },
    { id: 'open-project', group: project.name, label: 'Open a project…', icon: 'plus', run: () => setDialog({ kind: 'project' }) },
  ];
  const moreMenu: MenuItem[] = MORE.map((v) => ({
    id: `more-${v}`, label: label(v), kind: 'radio', checked: v === view, keys: ['G', keyOf(v) ?? ''], sequence: true,
    run: () => navigate({ name: 'project', projectKey: project.key, view: v }),
  }));
  const tip = (v: View): string => `${label(v)} (G then ${keyOf(v) ?? ''})`;

  return (
    <section className={`view${view === 'code' ? ' view-code' : ''}`} aria-labelledby="project-title">
      <header className="topbar project-bar">
        <h1 id="project-title" className="project-name">
          <MenuButton label={project.name} items={nameMenu} className="project-name-button" width={300} tip="Switch project, its settings, its folder">
            <span className="project-name-text">{project.name}</span>
            <Icon name="down" size={14} />
          </MenuButton>
        </h1>
        <NavTabs label={`${project.name} views`} className="project-tabs" stripRef={tabs}
          items={[
            ...TABBED.map((v) => ({
              href: to(v), label: label(v), current: v === view, tip: tip(v),
              ...(v === 'sessions' && project.liveSessions ? { count: project.liveSessions } : {}),
            })),
            // Always offered: while it is off, the tab says so and switches it on in place.
            { href: to(LIVE_VIEW.view), label: LIVE_VIEW.label, current: view === LIVE_VIEW.view, tip: 'The project’s local site, following the agents’ edits' },
          ]}>
          <MenuButton label={`More views: History, Decisions, Activity, List${inMore ? `. Showing ${label(view)}` : ''}`} items={moreMenu}
            className={`project-more${inMore ? ' active' : ''}`} width={240} tip="History, Decisions, Activity, List">
            {inMore ? <><span>{label(view)}</span><Icon name="down" size={12} /></> : <Icon name="more" size={16} />}
          </MenuButton>
        </NavTabs>
        <span className={`presence${project.liveSessions ? ' working' : ''}`}>
          <span className="presence-mark" aria-hidden="true" />
          <span className="presence-text">{project.liveSessions ? plural(project.liveSessions, 'session') + ' running' : 'Nothing running'}</span>
        </span>
        <div className="topbar-tools">
          {project.pausedAt
            ? <Button tone="primary" size="s" icon="resume" onClick={resume}>Resume</Button>
            : <Button size="s" icon="pause" onClick={() => setPausing(true)} data-tip="Pause new sessions and claims here">Pause</Button>}
        </div>
      </header>
      {project.pausedAt ? (
        <div className="banner banner-paused" role="status">
          <Icon name="pause" size={15} />
          <span>
            Paused {ago(project.pausedAt)}. New sessions and claims are blocked here.
            {project.liveSessions ? ` ${plural(project.liveSessions, 'session is', 'sessions are')} still running.` : ' Nothing is running.'}
          </span>
        </div>
      ) : null}
      {pausing ? <PauseDialog project={project} onClose={() => setPausing(false)} /> : null}
      {settings ? <ProjectSettingsDialog project={project} onClose={() => setSettings(false)} /> : null}
      {!project.pathOk ? (
        <div className="banner banner-red">The folder {project.path} is missing. Sessions cannot start here until it is back.</div>
      ) : null}
      {/* The Code tab has no body of its own: the code editor (editor/EditorDrawer.tsx) fills this place, beside the project's files. */}
      <div className="view-body" hidden={view === 'code'}>
        {view === 'board' ? <Board key={project.id} project={project} setDialog={setDialog} /> : null}
        {view === 'list' ? <ListView project={project} /> : null}
        {view === 'sessions' ? <SessionsView project={project} setDialog={setDialog} /> : null}
        {view === 'history' ? <HistoryView key={project.id} project={project} /> : null}
        {view === 'changes' ? <ChangesView project={project} /> : null}
        {view === 'decisions' ? <DecisionsView project={project} /> : null}
        {view === 'activity' ? <ActivityView project={project} /> : null}
        {view === LIVE_VIEW.view ? <LivePane project={project} /> : null}
      </div>
    </section>
  );
}

/* ── list ─────────────────────────────────────────────────────────────────── */

type SortKey = 'key' | 'title' | 'status' | 'priority' | 'updated';
const STATUS_ORDER = { inbox: 0, ready: 1, working: 2, review: 3, done: 4, archived: 5 } as const;

function ListView({ project }: { project: ProjectSummary }) {
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

/* ── sessions ─────────────────────────────────────────────────────────────── */

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

function SessionsView({ project, setDialog }: { project: ProjectSummary; setDialog: (d: DialogState) => void }) {
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

/* ── decisions ────────────────────────────────────────────────────────────── */

function DecisionsView({ project }: { project: ProjectSummary }) {
  const decisions = useQuery('decisions.list', { projectId: project.id }, ['decisions'], forProject(project.id));
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const once = useSingleFlight();

  const add = (): Promise<void> => once(async () => {
    if (!title.trim()) return;
    const ok = await attempt(() => call('decisions.add', { projectId: project.id, title, body }), (m) => toast(m, 'error'));
    if (ok) { setTitle(''); setBody(''); }
  });

  return (
    <div className="view-pad decisions">
      <p className="lede">Decisions are rules for this project. Every session that starts here is told them, and you can change them at any time.</p>
      <form className="decision-new" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="visually-hidden" htmlFor="decision-title">Decision</label>
        <input id="decision-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A decision, e.g. “Use pnpm, never npm”" />
        <label className="visually-hidden" htmlFor="decision-body">Why, or detail</label>
        <textarea id="decision-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Why, or any detail an agent needs (optional)" rows={2} />
        <div><Button tone="primary" type="submit" disabled={!title.trim()}>Record decision</Button></div>
      </form>
      {decisions.error ? <NotAnswering error={decisions.error} onRetry={decisions.reload} /> : decisions.data?.length ? (
        <ol className="decision-list">
          {decisions.data.map((d) => (
            <li key={d.id} className="decision">
              {editing === d.id ? (
                <DecisionEdit id={d.id} title={d.title} body={d.body} onDone={() => setEditing(null)} />
              ) : (
                <>
                  <div className="decision-text">
                    <p className="decision-title">{d.title}</p>
                    {d.body ? <p className="decision-body">{d.body}</p> : null}
                    <p className="faint decision-when">Recorded {ago(d.createdAt)}{d.updatedAt !== d.createdAt ? `, changed ${ago(d.updatedAt)}` : ''}</p>
                  </div>
                  <div className="decision-actions">
                    <Button size="s" tone="quiet" onClick={() => setEditing(d.id)}>Edit</Button>
                    <Button size="s" tone="quiet" onClick={() => attempt(() => call('decisions.remove', { id: d.id }), (m) => toast(m, 'error'))}>Withdraw</Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ol>
      ) : decisions.data ? <p className="faint">No decisions yet.</p> : null}
    </div>
  );
}

function DecisionEdit({ id, title, body, onDone }: { id: string; title: string; body: string; onDone: () => void }) {
  const [t, setT] = useState(title);
  const [b, setB] = useState(body);
  const toast = useToast();
  const once = useSingleFlight();
  // A refused edit stays open with its text, to try again.
  const save = (): Promise<void> => once(() => attempt(() => call('decisions.update', { id, title: t, body: b }), (m) => toast(m, 'error'))
    .then((r) => { if (r) onDone(); }));
  return (
    <form className="decision-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="visually-hidden" htmlFor={`dt-${id}`}>Decision</label>
      <input id={`dt-${id}`} value={t} onChange={(e) => setT(e.target.value)} />
      <label className="visually-hidden" htmlFor={`db-${id}`}>Detail</label>
      <textarea id={`db-${id}`} value={b} onChange={(e) => setB(e.target.value)} rows={2} />
      <div className="row-gap"><Button tone="primary" type="submit">Save</Button><Button tone="quiet" onClick={onDone}>Cancel</Button></div>
    </form>
  );
}

/* ── activity ─────────────────────────────────────────────────────────────── */

function ActivityView({ project }: { project: ProjectSummary }) {
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
