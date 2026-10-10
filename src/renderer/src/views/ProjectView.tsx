import { useEffect, useRef, useState } from 'react';
import type { ProjectSummary } from '@shared/model';
import { attempt, bridge, call } from '../lib/api';
import { LIVE_VIEW, PROJECT_VIEWS, href, navigate, type ProjectView as View } from '../lib/router';
import { LivePane } from '../components/Live';
import { ago, fileManager, plural } from '../lib/format';
import { Icon } from '../components/icons';
import { MenuButton, type MenuItem } from '../components/Menu';
import { NavTabs } from '../components/Tabs';
import { Button, useToast } from '../components/ui';
import { PauseDialog, ProjectSettingsDialog } from '../dialogs/ProjectDialogs';
import { ActivityView } from './ActivityView';
import { Board } from './Board';
import { ChangesView } from './ChangesView';
import { DecisionsView } from './DecisionsView';
import { HistoryView } from './HistoryView';
import { ListView } from './ListView';
import { SessionsView } from './SessionsView';
import type { DialogState } from '../App';

/** The views the bar shows as tabs, in order; the rest are under ··· (and in the palette, by G then their key). List is
 * the board's other mode (its toolbar switches them), so the Board tab is current on it too. */
const TABBED: readonly View[] = ['board', 'sessions', 'changes', 'code'];
const MORE: readonly View[] = ['history', 'decisions', 'activity'];
const isCurrent = (tab: View, view: View): boolean => tab === view || (tab === 'board' && view === 'list');

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
        <NavTabs label={`${project.name} views`} className="project-tabs" stripRef={tabs} tour="project-views"
          items={[
            ...TABBED.map((v) => ({
              href: to(v), label: label(v), current: isCurrent(v, view), tip: tip(v),
              ...(v === 'sessions' && project.liveSessions ? { count: project.liveSessions } : {}),
            })),
            // Always offered: while it is off, the tab says so and switches it on in place.
            { href: to(LIVE_VIEW.view), label: LIVE_VIEW.label, current: view === LIVE_VIEW.view, tip: 'The project’s local site, following the agents’ edits', tour: 'project-live' },
          ]}>
          <MenuButton label={`More views: History, Decisions, Activity${inMore ? `. Showing ${label(view)}` : ''}`} items={moreMenu}
            className={`project-more${inMore ? ' active' : ''}`} width={240} tip="History, Decisions, Activity">
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
        {view === 'list' ? <ListView project={project} setDialog={setDialog} /> : null}
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
