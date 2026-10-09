import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CardStatus } from '@shared/model';
import { useOrbLabRoute } from './orb/lab-route';
import { bridge, useQuery } from './lib/api';
import { LIVE_VIEW, PROJECT_VIEWS, gitHref, href, navigate, openCard, parse, useLocation, type Route } from './lib/router';
import { INTENT_TAB, requestGit, type GitIntent } from './lib/git-intent';
import { Rail } from './shell/Rail';
import { useRail } from './lib/rail';
import { NotAnswering, ToastProvider } from './components/ui';
import { NeedsView } from './views/NeedsView';
import { RunningView } from './views/RunningView';
import { AccountsView } from './views/AccountsView';
import { SkillsView } from './views/SkillsView';
import { McpView } from './views/McpView';
import { SettingsView } from './views/SettingsView';
import { ProjectView } from './views/ProjectView';
import { SessionView } from './views/SessionView';
import { CardDrawer } from './views/CardDrawer';
import { NewCardDialog } from './dialogs/NewCardDialog';
import { NewSessionDialog } from './dialogs/NewSessionDialog';
import { AddProjectDialog } from './dialogs/AddProjectDialog';
import { Palette } from './dialogs/Palette';
import { TalkToWanigan } from './components/Chat';
import { Chatter } from './components/Chatter';
import { Alerts } from './components/Alerts';
import { ViewBoundary } from './components/ViewBoundary';
import { CoreProblemPanel } from './components/CoreProblem';
import { ShortcutSheet } from './dialogs/ShortcutSheet';
import { EditorDrawer } from './editor/EditorDrawer';
import { openQuickOpen, toggleEditor } from './editor/store';
import { COMMAND_IDS, matchKey, type CommandId } from '@shared/shortcuts';
import { windowTitle } from '@shared/views';

export type DialogState =
  | null
  | { kind: 'card'; projectId?: string; status?: Extract<CardStatus, 'inbox' | 'ready'> }
  | { kind: 'session'; projectId?: string; cardId?: string }
  | { kind: 'project' }
  | { kind: 'palette' }
  | { kind: 'shortcuts' };

const OrbLab = lazy(() => import('./orb/OrbLab').then((m) => ({ default: m.OrbLab })));

export function App() {
  // A hidden development page for Wanigan's animations; not in the rail or the palette.
  if (useOrbLabRoute()) return <Suspense fallback={null}><OrbLab /></Suspense>;
  return (
    <ToastProvider>
      <ViewBoundary name="Wanigan’s window">
        <Shell />
      </ViewBoundary>
    </ToastProvider>
  );
}

function Shell() {
  const location = useLocation();
  const projects = useQuery('projects.list', {}, ['projects', 'needs', 'sessions']);
  const needs = useQuery('needs.list', {}, ['needs', 'sessions', 'board']);
  const hello = useQuery('core.hello', {}, []);
  const [dialog, setDialog] = useState<DialogState>(null);
  const close = useCallback(() => setDialog(null), []);

  const route = location.route;
  const project = useMemo(() => {
    if (route.name !== 'project' && route.name !== 'session') return undefined;
    return projects.data?.find((p) => p.key === route.projectKey);
  }, [route, projects.data]);

  // The window's title says where you are (Window menu, Mission Control, ⌘`).
  const titleSession = useQuery('sessions.get', route.name === 'session' ? { id: route.sessionId } : null, ['sessions'],
    (_e, d) => route.name === 'session' && (d as { sessionId?: string })?.sessionId === route.sessionId);
  const sessionTitle = route.name === 'session' ? (titleSession.data?.session.title ?? null) : null;
  useEffect(() => {
    document.title = windowTitle({
      view: route.name === 'session' ? 'Session' : viewName(route),
      project: route.name === 'project' || route.name === 'session' ? (project?.name ?? route.projectKey) : null,
      session: sessionTitle,
      card: location.card,
    });
  }, [route, project?.name, sessionTitle, location.card]);

  const projectKeys = useMemo(() => projects.data?.map((p) => p.key) ?? [], [projects.data]);
  const rail = useRail();
  const runCommand = useCommands({ dialog, setDialog, projectId: project?.id, projects: projectKeys, toggleRail: rail.toggle });

  useEffect(() => bridge().onNavigate((hash) => { window.location.hash = hash; }), []);

  // With no projects yet, the first thing to do is open one.
  const prompted = useRef(false);
  useEffect(() => {
    if (!prompted.current && projects.data && projects.data.length === 0) {
      prompted.current = true;
      setDialog({ kind: 'project' });
    }
  }, [projects.data]);

  return (
    <div className={`app${location.card ? ' with-drawer' : ''}`}>
      <ViewBoundary name="The sidebar" compact>
        <Rail
          projects={projects.data}
          needs={needs.data}
          location={location}
          collapsed={rail.collapsed}
          onToggle={rail.toggle}
          onNewSession={() => setDialog({ kind: 'session', ...(project ? { projectId: project.id } : {}) })}
          onNewCard={() => setDialog({ kind: 'card', ...(project ? { projectId: project.id } : {}) })}
          onAddProject={() => setDialog({ kind: 'project' })}
          onPalette={() => setDialog({ kind: 'palette' })}
        />
      </ViewBoundary>
      <main className="main" id="main">
        {hello.data?.demo ? (
          <div className="demo-banner" role="status">
            <strong>Demo</strong>
            <span>Sample projects and stand-in agents. Nothing here touches your real work, and no model is called.</span>
            <button type="button" className="linkish" onClick={() => window.close()}>Leave the demo</button>
          </div>
        ) : null}
        <CoreProblemPanel />
        {/* The view, and the code editor's drawer beneath (or beside) it. */}
        <div className="work">
        <ViewBoundary name={viewName(route)} resetKey={href(route)}>
        {route.name === 'needs' ? (
          <NeedsView needs={needs.data} projects={projects.data} loading={needs.loading && !needs.data} onAddProject={() => setDialog({ kind: 'project' })}
            error={needs.error ?? projects.error} onRetry={() => { needs.reload(); projects.reload(); }} />
        ) : route.name === 'accounts' ? (
          <AccountsView projects={projects.data} />
        ) : route.name === 'skills' ? (
          <SkillsView projects={projects.data} />
        ) : route.name === 'mcp' ? (
          <McpView projects={projects.data} />
        ) : route.name === 'settings' ? (
          <SettingsView projects={projects.data} />
        ) : route.name === 'running' ? (
          <RunningView projects={projects.data} needs={needs.data} onNewSession={() => setDialog({ kind: 'session' })} />
        ) : route.name === 'project' ? (
          project ? (
            <ProjectView project={project} view={route.view} setDialog={setDialog} />
          ) : projects.error ? <NotAnswering error={projects.error} onRetry={projects.reload} /> : (
            <Missing loading={projects.loading} what={`project ${route.projectKey}`} />
          )
        ) : project ? (
          <SessionView project={project} sessionId={route.sessionId} />
        ) : projects.error ? <NotAnswering error={projects.error} onRetry={projects.reload} /> : (
          <Missing loading={projects.loading} what="this session" />
        )}
        </ViewBoundary>
        <ViewBoundary name="The code editor" compact>
          <EditorDrawer project={project ?? null} />
        </ViewBoundary>
        </div>
      </main>
      {location.card ? (
        <ViewBoundary name={`Card ${location.card}`} resetKey={location.card} compact onClose={() => openCard(null)}
          frame={(panel) => <aside className="drawer" aria-label={`Card ${location.card}`}>{panel}</aside>}>
          <CardDrawer cardKey={location.card} onClose={() => openCard(null)} setDialog={setDialog} />
        </ViewBoundary>
      ) : null}
      <ViewBoundary name="Talk to Wanigan" frame={() => null}><TalkToWanigan project={project} hidden={route.name === 'session'} /></ViewBoundary>

      <ViewBoundary name="This dialog" resetKey={dialog?.kind ?? ''} compact onClose={close}
        frame={(panel) => createPortal(<div className="scrim"><div className="dialog">{panel}</div></div>, document.body)}>
        {dialog?.kind === 'card' ? <NewCardDialog projects={projects.data ?? []} initial={dialog} onClose={close} /> : null}
        {dialog?.kind === 'session' ? <NewSessionDialog projects={projects.data ?? []} initial={dialog} onClose={close} /> : null}
        {dialog?.kind === 'project' ? <AddProjectDialog onClose={close} /> : null}
        {dialog?.kind === 'palette' ? (
          <Palette projects={projects.data ?? []} currentProject={project} onClose={close} setDialog={setDialog} runCommand={(id) => runCommand(id, 'menu')} />
        ) : null}
        {dialog?.kind === 'shortcuts' ? <ShortcutSheet onClose={close} /> : null}
      </ViewBoundary>
      {/* Overlays: if one of these breaks, it steps aside rather than take the window with it. */}
      <ViewBoundary name="Agents talking" frame={() => null}><Chatter projects={projects.data} /></ViewBoundary>
      <ViewBoundary name="Alerts" frame={() => null}><Alerts needs={needs.data} location={location} /></ViewBoundary>
    </div>
  );
}

/** What the main view is called, for its crash panel. */
function viewName(route: Route): string {
  switch (route.name) {
    case 'needs': return 'Needs you';
    case 'running': return 'Running';
    case 'accounts': return 'Accounts';
    case 'settings': return 'Settings';
    case 'skills': return 'Skills';
    case 'mcp': return 'MCP servers';
    case 'project': return route.view === LIVE_VIEW.view ? 'Live view' : PROJECT_VIEWS.find((v) => v.view === route.view)?.label ?? 'This view';
    case 'session': return 'This session';
  }
}

function Missing({ loading, what }: { loading: boolean; what: string }) {
  return <div className="view-pad faint">{loading ? 'Loading…' : `Wanigan can’t find ${what}. It may have been closed.`}</div>;
}

/**
 * Keys and menu commands: one table of shortcuts (shared/shortcuts.ts) decides
 * what a key means, and this one place runs it, whether it came from the
 * keyboard or the app menu.
 */
function useCommands({ dialog, setDialog, projectId, projects, toggleRail }: {
  dialog: DialogState;
  setDialog: (d: DialogState) => void;
  projectId: string | undefined;
  projects: string[];
  toggleRail: () => void;
}): (id: CommandId, from: 'key' | 'menu') => boolean {
  const pendingG = useRef<number>(0);
  /** A key toggles the palette and the sheet; the menu only opens them, so the two can never cancel out. */
  const run = useCallback((id: CommandId, from: 'key' | 'menu'): boolean => {
    const currentProject = (): string | null => {
      const m = location.hash.match(/#\/p\/([^/?]+)/)?.[1];
      return m ? decodeURIComponent(m) : null;
    };
    switch (id) {
      case 'palette': setDialog(from === 'key' && dialog?.kind === 'palette' ? null : { kind: 'palette' }); return true;
      case 'shortcuts': setDialog(from === 'key' && dialog?.kind === 'shortcuts' ? null : { kind: 'shortcuts' }); return true;
      case 'new-session': setDialog({ kind: 'session', ...(projectId ? { projectId } : {}) }); return true;
      case 'new-card':
        if (!projects.length) return false;
        setDialog({ kind: 'card', ...(projectId ? { projectId } : {}) });
        return true;
      case 'close-card':
        // Not consumed: the drawer listens for Escape too.
        if (location.hash.includes('card=')) openCard(null);
        return false;
      case 'toggle-rail': toggleRail(); return true;
      case 'quick-open': {
        // Over a card's worktree when the Changes view shows one; otherwise the project folder.
        if (!currentProject()) return false;
        const shown = parse(location.hash);
        setDialog(null);
        openQuickOpen(shown.route.name === 'project' && shown.route.view === 'changes' ? shown.branch : null);
        return true;
      }
      case 'toggle-editor':
        if (!currentProject()) return false;
        toggleEditor();
        return true;
      case 'settings': case 'go-settings': navigate({ name: 'settings' }); return true;
      case 'go-needs': navigate({ name: 'needs' }); return true;
      case 'go-running': navigate({ name: 'running' }); return true;
      case 'go-accounts': navigate({ name: 'accounts' }); return true;
      case 'history': {
        // ⌘⇧T reopens what came before: this project's History.
        const current = currentProject();
        if (!current) return false;
        setDialog(null);
        navigate({ name: 'project', projectKey: current, view: 'history' });
        return true;
      }
      case 'git-commit': case 'git-push': case 'git-pull': case 'git-fetch': case 'git-switch': case 'git-branch': case 'git-stash': {
        // Git happens in the open project's Changes view: go there (keeping a card's worktree if one is shown), then do it.
        const current = currentProject();
        if (!current) return false;
        const intent = id.slice('git-'.length) as GitIntent;
        const shown = parse(location.hash);
        const card = shown.route.name === 'project' && shown.route.view === 'changes' ? shown.branch : null;
        setDialog(null);
        const target = gitHref(current, INTENT_TAB[intent], card);
        if (location.hash !== target) location.hash = target;
        requestGit(intent);
        return true;
      }
      default: {
        if (id.startsWith('project-')) {
          const key = projects[Number(id.slice('project-'.length)) - 1];
          if (!key) return false;
          navigate({ name: 'project', projectKey: key, view: 'board' });
          return true;
        }
        const view = PROJECT_VIEWS.find((v) => id === `go-${v.view}`);
        const current = currentProject();
        if (!view || !current) return false;
        navigate({ name: 'project', projectKey: current, view: view.view });
        return true;
      }
    }
  }, [dialog, setDialog, projectId, projects, toggleRail]);

  useEffect(() => {
    const mac = bridge().platform === 'darwin';
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return; // a view already handled this key
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || !!target.closest('.xterm'));
      const afterG = Date.now() - pendingG.current < 1200;
      const modal = !!dialog || !!document.querySelector('[aria-modal="true"]');
      const match = matchKey(e, { mac, typing, dialog: modal, afterG });
      // Any plain key after G ends the sequence, whether or not it went anywhere.
      if (afterG && !typing && !dialog && !e.metaKey && !e.ctrlKey && !e.altKey) pendingG.current = 0;
      if (!match) return;
      if ('pending' in match) { pendingG.current = Date.now(); return; }
      if (run(match.id, 'key')) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    const off = bridge().onCommand((id) => { if (COMMAND_IDS.has(id)) run(id as CommandId, 'menu'); });
    return () => { window.removeEventListener('keydown', onKey); off(); };
  }, [dialog, run]);
  return run;
}
