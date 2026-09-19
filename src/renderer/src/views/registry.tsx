import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { Attention, Project, ProviderInfo, Session } from '@shared/types';
import type { Tab } from '@shared/routes';
import type { CompanionPresenceState, PresenceRead } from '@shared/companion-presence';
import type { OrbStory } from '@shared/orb-story';
import type { ThemeState } from '../theme';
import { PageHead, Segmented } from '../components/bits';
import MissionRoom from './MissionRoom';
import Sessions from './Sessions';
import Fleet from './Fleet';
import Board from './Board';
import Control from './Control';
import Batches from './Batches';
import InsightsView from './Insights';
import UsageView from './Usage';
import Learning from './Learning';
import ImprovementScout from './ImprovementScout';
import Skills from './Skills';
import Context from './Context';
import Plugins from './Plugins';
import Extensions from './Extensions';
import Schedules from './Schedules';
import Git from './Git';
import HeadlessRuns from './HeadlessRuns';
import Relay from './Relay';
import SettingsView, { DemoPanel, type SettingsJump } from './Settings';

/** One-shot deep link into Learning, consumed by nonce like newSessionRequest. */
type LearningTarget = { tab: 'overview' | 'inbox' | 'knowledge' | 'optimize'; nonce: number };
/** A conversation to open in Sessions' history; a null sessionId means the newest. */
type HistoryRequest = { sessionId: string | null; query: string; nonce: number };
/** A session handing its changed files to a new batch run. */
type BatchSeed = { projectId: string; root: string; paths: string[] };

/**
 * The bag App.tsx used to thread by hand into each `tab === '…' &&` branch.
 *
 * Every field is the shell's own state or handler under the name the shell
 * gives it. Nothing is renamed, wrapped or merged on the way through, so a
 * view's props below mean exactly what they meant in the chain: `choose` and
 * `setSpaceId` both travel even though Board calls them together, the raw
 * state setters travel so the inline `onXConsumed={() => set…(null)}` lambdas
 * stay as they were, and `theme` travels whole because Settings reads three
 * of its fields. Collecting this is the one part of the seam that is a
 * refactor rather than a move, which is why it changes no prop's meaning.
 */
export type ViewContext = {
  // Shared records the shell polls or loads once.
  projects: Project[];
  projectsRead: boolean;
  providers: ProviderInfo[];
  sessions: Session[];
  attention: Attention[];
  attentionRead: PresenceRead;
  presence: CompanionPresenceState;
  orbStory: OrbStory;
  hasKey: boolean;
  demoOn: boolean;
  theme: ThemeState;
  // The shared selection: the project you are looking at and the session you
  // are talking to.
  projectId: string;
  spaceId: string | null;
  setSpaceId: Dispatch<SetStateAction<string | null>>;
  activeSessionId: string | null;
  setActiveSessionId: Dispatch<SetStateAction<string | null>>;
  // One-shot requests a view consumes after it mounts.
  newSessionRequest: number | null;
  consumeNewSessionRequest: () => void;
  historyRequest: HistoryRequest | null;
  setHistoryRequest: Dispatch<SetStateAction<HistoryRequest | null>>;
  batchSeed: BatchSeed | null;
  setBatchSeed: Dispatch<SetStateAction<BatchSeed | null>>;
  learningTarget: LearningTarget | null;
  settingsJump: SettingsJump | null;
  // Doors and handlers.
  go: (next: Tab) => void;
  choose: (id: string) => void;
  openSession: (id: string) => void;
  openGoal: (id: string, taskId?: string) => void;
  openLearning: (target: LearningTarget['tab']) => void;
  focusSession: (id: string, projectId?: string) => void;
  requestNewSession: () => void;
  jumpToSettings: (jump: Omit<SettingsJump, 'nonce'>) => void;
  addProject: () => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  loadShell: () => Promise<void>;
  reportSessionError: (message: string) => void;
};

/**
 * Each destination's renderer, keyed by route id and typed over every `Tab`.
 *
 * This is the one row of a view's registration that nothing used to check: a
 * route present in every table with no branch in App.tsx rendered an empty
 * pane while all eight gates passed. `Record<Tab, …>` makes the missing entry
 * a compile error instead, and an entry for an id that is not a route is one
 * too. Each entry renders exactly the element its branch rendered, with
 * exactly the props it passed; the destructured parameter is the shell state
 * that branch read. The demo placeholder, the error boundary, the per-view
 * memory scope and the per-tab effects stay in App.tsx around the one call.
 */
export const VIEW_RENDERERS: Record<Tab, (ctx: ViewContext) => ReactNode> = {
  mission: ({ attention, attentionRead, projects, projectsRead, go, orbStory, activeSessionId, sessions, setActiveSessionId, demoOn, spaceId, presence, openSession, choose, addProject, requestNewSession, jumpToSettings }) => (
    <MissionRoom attention={attention} attentionRead={attentionRead} projects={projects} projectsRead={projectsRead} onFleet={() => go('fleet')} story={orbStory} followedSession={activeSessionId} sessions={sessions} onFollow={setActiveSessionId} demo={demoOn} projectId={spaceId} presence={presence} onOpenSession={openSession}
            onProject={(id) => { choose(id); go('sessions'); }} onAddProject={addProject}
            onNewSession={requestNewSession} onSettings={() => jumpToSettings({ tab: 'agents', section: 'Claude Platform API key' })}
            onUsage={() => go('usage')} />
  ),
  sessions: ({ providers, projects, spaceId, addProject, reportSessionError, openGoal, activeSessionId, focusSession, newSessionRequest, consumeNewSessionRequest, historyRequest, setHistoryRequest, jumpToSettings, setBatchSeed, go }) => (
    <Sessions providers={providers} projects={projects} selectedProjectId={spaceId}
              onAddProject={addProject} onError={reportSessionError} onOpenGoal={openGoal}
              activeId={activeSessionId} onActiveChange={focusSession}
              newSessionRequest={newSessionRequest} onNewSessionRequestConsumed={consumeNewSessionRequest}
              historyRequest={historyRequest} onHistoryRequestConsumed={() => setHistoryRequest(null)}
              onOpenSettings={jumpToSettings}
              onSendToBatch={(seed) => { setBatchSeed(seed); go('batches'); }} />
  ),
  fleet: ({ projects, openSession, requestNewSession }) => (
    <Fleet projects={projects} onOpenSession={openSession} onNewSession={requestNewSession} />
  ),
  board: ({ projects, providers, projectId, spaceId, setSpaceId, choose, openGoal, openSession }) => (
    <Board projects={projects} providers={providers} projectId={projectId} selectedProjectId={spaceId}
           onPickProject={(id) => { setSpaceId(id); if (id) choose(id); }}
           onOpenGoal={openGoal} onOpenSession={openSession} />
  ),
  control: ({ projects, providers, openSession }) => (
    <Control projects={projects} providers={providers} onOpenSession={openSession} />
  ),
  // Land on the key, not on Settings. The nav mark beside this tab already
  // deep-links to the exact section; sending the operator to the top of a
  // 5,000-line surface to find it themselves was the one door that did not.
  batches: ({ projects, hasKey, jumpToSettings, batchSeed, setBatchSeed }) => (
    <Batches projects={projects} hasKey={hasKey}
             onNeedKey={() => jumpToSettings({ tab: 'agents', section: 'Claude Platform API key' })}
             seed={batchSeed} onSeedConsumed={() => setBatchSeed(null)} />
  ),
  insights: () => <InsightsView />,
  usage: () => <UsageView />,
  learning: ({ projectId, projects, providers, choose, learningTarget }) => (
    <Learning projectId={projectId} projects={projects} providers={providers}
              onPickProject={choose} initialTarget={learningTarget} />
  ),
  // Scout talks to window.wanigan.scout and nothing else in this app does.
  // Its props are unchanged from when it hung off Learning.
  scout: ({ projects, openGoal }) => (
    <ImprovementScout projects={projects} onOpenGoal={openGoal} />
  ),
  skills: ({ projectId, providers, activeSessionId, sessions }) => (
    <Skills projectId={projectId} providers={providers} activeSession={sessions.find(session => session.id === activeSessionId)} />
  ),
  context: ({ projectId, projects, projectsRead, choose, loadShell, openLearning }) => (
    <Context projectId={projectId} projects={projects} projectsRead={projectsRead} onPickProject={choose}
             onReloadProjects={loadShell} onOpenLearning={openLearning} />
  ),
  plugins: () => <Plugins />,
  extensions: () => <Extensions />,
  schedules: ({ projects }) => <Schedules projects={projects} />,
  git: ({ projects, projectsRead, spaceId, projectId, choose }) => (
    <Git projects={projects} projectsRead={projectsRead} selectedProjectId={spaceId ?? projectId} onPickProject={choose} />
  ),
  relay: ({ projects, projectId, spaceId, providers, openSession, openGoal }) => (
    <Relay projects={projects} projectId={spaceId ?? projectId} providers={providers} openSession={openSession} openGoal={openGoal} />
  ),
  runs: ({ projects, providers }) => <HeadlessRuns projects={projects} providers={providers} />,
  settings: ({ demoOn, theme, providers, projects, settingsJump, openSession, loadShell, removeProject, addProject }) => (demoOn ? <main className="pane">
    <PageHead title="Settings" eyebrow="Demo workspace" lead="These appearance choices apply only to this demo." />
    <Segmented label="Demo theme" value={theme.preference} options={[{value:'dark',label:'Dark'},{value:'light',label:'Light'},{value:'system',label:'System'}]} onChange={theme.setTheme} />
    <DemoPanel />
  </main> : <SettingsView providers={providers} projects={projects} jump={settingsJump} onOpenSession={openSession}
                  onKeyChange={loadShell} onRemoveProject={removeProject} onAddProject={addProject}
                  themePreference={theme.preference} resolvedTheme={theme.resolved} onThemeChange={theme.setTheme} />
  ),
};
