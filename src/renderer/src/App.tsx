import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Attention, AttentionKind, MotionSetting, Project, ProviderInfo, Session } from '@shared/types';
import Sessions from './views/Sessions';
import Fleet from './views/Fleet';
import Control from './views/Control';
import Batches from './views/Batches';
import InsightsView from './views/Insights';
import Learning from './views/Learning';
import Plugins from './views/Plugins';
import Schedules from './views/Schedules';
import Git from './views/Git';
import HeadlessRuns from './views/HeadlessRuns';
import SettingsView from './views/Settings';
import Skills from './views/Skills';
import Context from './views/Context';
import { num } from './components/bits';
import ErrorBoundary from './components/ErrorBoundary';
import ThemeControl from './components/ThemeControl';
import { useThemePreference } from './theme';
import { selectedProviderStatus, selectedSessionTelemetry } from '@shared/provider-status';

type CodexStatus = {
  fetchedAt: number; plan: string | null; spendControlReached: boolean | null;
  primary: { usedPercent: number; remainingPercent: number; resetsAt: number | null; windowMinutes: number | null } | null;
  secondary: { usedPercent: number; remainingPercent: number; resetsAt: number | null; windowMinutes: number | null } | null;
};

type StartupStatus = {
  phase: 'starting' | 'ready' | 'recovery';
  stage: string | null;
  message: string | null;
};

/**
 * The shell: which surface is on screen, what the nav is allowed to shout
 * about, and the one piece of app-wide state the views share — the project you
 * are looking at and the session you are talking to.
 *
 * Two rules here are load-bearing rather than taste:
 *
 *  - The PTY owns its keystrokes. ⌘1–9 switch views only when focus is outside
 *    a terminal; inside one, every key belongs to the agent.
 *  - Nothing animates around a live terminal. A view transition that fades or
 *    slides a pane containing a running PTY fights xterm's own repaint, and the
 *    thing that ends up looking broken is the terminal. When either side of a
 *    view swap holds a live session, the swap is instant on purpose.
 */

const TABS = [
  { id: 'sessions',  label: 'Sessions',  group: 'Work',    keywords: 'agent terminal conversation interactive' },
  { id: 'fleet',     label: 'Fleet',     group: 'Work',    keywords: 'monitor activity status' },
  { id: 'control',   label: 'Control',   group: 'Work',    keywords: 'goals goal dockets tasks work graph' },
  { id: 'batches',   label: 'Batches',   group: 'Work',    keywords: 'batch api bulk fan-out' },
  { id: 'insights',  label: 'Insights',  group: 'Explore', keywords: 'spend costs usage analytics' },
  { id: 'learning',  label: 'Learning',  group: 'Explore', keywords: 'knowledge memory improvement' },
  { id: 'plugins',   label: 'Plugins',   group: 'Explore', keywords: 'extensions integrations' },
  { id: 'schedules', label: 'Schedules', group: 'Explore', keywords: 'automation cron recurring' },
  { id: 'git',       label: 'Git',       group: 'Manage',  keywords: 'worktrees commits review' },
  { id: 'runs',      label: 'Runs',      group: 'Manage',  keywords: 'headless fan-out automation' },
  { id: 'settings',  label: 'Settings',  group: 'Manage',  keywords: 'preferences providers connections appearance' },
  { id: 'skills',    label: 'Skills',    group: 'Explore', keywords: 'agent skills instructions workflows' },
  { id: 'context',   label: 'Context',   group: 'Explore', keywords: 'instructions memory configuration' },
] as const;

type Tab = (typeof TABS)[number]['id'];

/**
 * The direct routes, written out once so the rail, the palette and the key
 * handler cannot drift apart. ⌘1–9 follow the first nine TABS entries and ⌘0
 * takes Runs; the three surfaces past the digit row get named chords rather
 * than a blank shortcut column that implies they cannot be reached at all.
 */
const TAB_SHORTCUTS: Record<Tab, { label: string; aria: string }> = {
  sessions:  { label: '⌘1', aria: 'Meta+1 Control+1' },
  fleet:     { label: '⌘2', aria: 'Meta+2 Control+2' },
  control:   { label: '⌘3', aria: 'Meta+3 Control+3' },
  batches:   { label: '⌘4', aria: 'Meta+4 Control+4' },
  insights:  { label: '⌘5', aria: 'Meta+5 Control+5' },
  learning:  { label: '⌘6', aria: 'Meta+6 Control+6' },
  plugins:   { label: '⌘7', aria: 'Meta+7 Control+7' },
  schedules: { label: '⌘8', aria: 'Meta+8 Control+8' },
  git:       { label: '⌘9', aria: 'Meta+9 Control+9' },
  runs:      { label: '⌘0', aria: 'Meta+0 Control+0' },
  settings:  { label: '⌘,', aria: 'Meta+, Control+,' },
  skills:    { label: '⌘⇧S', aria: 'Meta+Shift+S Control+Shift+S' },
  context:   { label: '⌘⇧C', aria: 'Meta+Shift+C Control+Shift+C' },
};

/** ⌘⇧ chords for the surfaces the digit row cannot reach. */
const SHIFT_CHORD_TABS: Record<string, Tab> = { s: 'skills', c: 'context' };

const labelForTab = (id: Tab): string => TABS.find((item) => item.id === id)?.label ?? id;

/** A Goal is a durable Control record. Honour its deep link before the first
 * render so opening a copied Goal URL cannot strand someone on Sessions with
 * a perfectly valid `#goal=` fragment that nothing visible is reading. */
function initialTabFromLocation(): Tab {
  try {
    const goal = new URLSearchParams(window.location.hash.slice(1)).get('goal');
    return goal ? 'control' : 'sessions';
  } catch {
    return 'sessions';
  }
}

// The wide rail prioritises the surfaces used continuously while an agent is
// running. Skills and Context reach the screen through ⌘⇧S / ⌘⇧C and the ⌘K
// palette without changing the long-standing ⌘1–9 map or turning the rail into
// a ticker — and the palette button says which of them is on screen, so an
// off-rail view is never a surface with no visible route back to it.
const NAV_RAIL_TABS: readonly Tab[] = [
  'sessions', 'fleet', 'control', 'batches', 'insights', 'learning',
  'plugins', 'schedules', 'git', 'runs', 'settings',
];

/** The kinds that mean a human is the blocker, worst first. */
const NEEDS_YOU: AttentionKind[] = ['permission', 'error', 'finished'];

/** Glyph and word first, colour last — a nav dot that is only red is invisible
 *  to the people who most need to see it. */
const NEED_MARK: Record<string, { glyph: string; tone: string; phrase: (n: number) => string }> = {
  permission: { glyph: '?', tone: 'alert',   phrase: (n) => `${n} waiting on a permission prompt` },
  error:      { glyph: '✕', tone: 'serious', phrase: (n) => `${n} stopped on an error` },
  finished:   { glyph: '✓', tone: 'ok',      phrase: (n) => `${n} finished, waiting for review` },
};

/** The only parts of a session list the shell reacts to. */
const shape = (l: Session[]) => l.map((s) => `${s.id}:${s.status}:${s.projectId}`).join('|');

type ViewTransitionDoc = Document & {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> };
};

/**
 * A shell-level failure the operator can act on. The message alone was a
 * click-anywhere-to-dismiss div: no keyboard route, no way to try the thing
 * again, and no route to the surface that owns the problem, so the only
 * recovery was reloading the window. Sessions, Skills and Learning all pair a
 * message with a retry; this is the same contract for the shell.
 */
type ShellRetry = { label: string; run: () => Promise<unknown> | void };
type ShellError = { message: string; retry?: ShellRetry; goTo?: Tab };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Motion is a setting, not a guess: 'auto' follows the OS, the other two win. */
function motionOn(): boolean {
  const m = document.documentElement.dataset.motion;
  if (m === 'off') return false;
  if (m === 'full') return true;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTabFromLocation);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [hasKey, setHasKey] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeRuns, setActiveRuns] = useState(0);
  // Requests returned out of requests submitted, across every run still in
  // flight. The nav bar advances on this and nothing else.
  const [batchWork, setBatchWork] = useState<{ done: number; total: number } | null>(null);
  const [needs, setNeeds] = useState<{ total: number; worst: AttentionKind | null; detail: string }>(
    { total: 0, worst: null, detail: '' });
  const [error, setError] = useState<ShellError | null>(null);
  const [retryingError, setRetryingError] = useState(false);
  const [startup, setStartup] = useState<StartupStatus | null>(null);
  const [retryingStartup, setRetryingStartup] = useState(false);
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  // The palette is a real modal. Remember where it came from so Escape and a
  // backdrop click put a keyboard user straight back where they started.
  const paletteOpenerRef = useRef<HTMLElement | null>(null);
  // Demo mode rewrites names at the IPC boundary, so the window can be showing
  // invented projects with nothing on screen saying so. The banner is read
  // once at start-up: demo:set reloads the window, which is what refreshes it.
  const [demoOn, setDemoOn] = useState(false);
  const [demoPrompt, setDemoPrompt] = useState<{ next: boolean } | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  // Which rail button holds the toolbar's single tab stop. Arrow keys move it
  // without switching view, so it can differ from the view on screen.
  const [navFocus, setNavFocus] = useState<Tab | null>(null);
  // A request is deliberately one-shot. The Sessions view consumes it after
  // it mounts, so a later visit to Sessions never reopens an old dialog.
  const [newSessionRequest, setNewSessionRequest] = useState<number | null>(null);
  // A session handing its changed files to a new batch run.
  const [batchSeed, setBatchSeed] = useState<{ projectId: string; root: string; paths: string[] } | null>(null);
  // Which session the keyboard-less surfaces should talk to.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // The project the user last chose or last worked in, remembered per machine.
  const [picked, setPicked] = useState<string | null>(() => localStorage.getItem('wanigan.project'));
  const theme = useThemePreference();

  const tabRef = useRef<Tab>(tab); tabRef.current = tab;
  const sessionsRef = useRef<Session[]>(sessions); sessionsRef.current = sessions;

  const running = useMemo(() => sessions.filter((s) => s.status === 'running').length, [sessions]);

  /** Report a failure with the work that would undo it, so the operator has
   *  something to press rather than a sentence to read. */
  const reportError = useCallback((cause: unknown, retry?: ShellRetry, goTo?: Tab) => {
    setError({ message: messageOf(cause), retry, goTo });
  }, []);

  /** Run the stored retry. A second failure keeps the same job attached, so the
   *  button stays pressable instead of turning into a dead sentence again. */
  const runErrorRetry = useCallback(() => {
    const job = error?.retry;
    if (!job || retryingError) return;
    const goTo = error?.goTo;
    setRetryingError(true);
    void Promise.resolve()
      .then(() => job.run())
      .then(() => setError(null))
      .catch((e) => setError({ message: messageOf(e), retry: job, goTo }))
      .finally(() => setRetryingError(false));
  }, [error, retryingError]);

  /** Views report a message, not a recovery. Name the surface that owns it so
   *  a failure raised from Sessions while you are on Insights still has a door. */
  const reportSessionError = useCallback((message: string) => {
    setError({ message, goTo: 'sessions' });
  }, []);

  const loadShell = useCallback(async () => {
    const [pv, pj, ks] = await Promise.all([
      window.wanigan.providers.list(),
      window.wanigan.projects.list(),
      window.wanigan.key.status(),
    ]);
    setProviders(pv); setProjects(pj); setHasKey(ks.present);
  }, []);

  useEffect(() => {
    void loadShell().catch((e) =>
      reportError(e, { label: 'Load providers and projects', run: loadShell }));
  }, [loadShell, reportError]);

  // The attended main process registers this channel before it touches the
  // database. A corrupted or partially migrated legacy DB therefore produces
  // a visible recovery banner instead of a window that looks empty or absent.
  useEffect(() => {
    let mounted = true;
    const read = () => window.wanigan.startup.status().then((state) => { if (mounted) setStartup(state); });
    void read().catch((e) => {
      if (mounted) reportError(e, { label: 'Read start-up status again', run: read });
    });
    const off = window.wanigan.on.startupChanged((state) => {
      if (mounted) setStartup(state);
    });
    return () => { mounted = false; off(); };
  }, [reportError]);

  /** Returns the attempt so a caller can decide what a second failure means. */
  const retryStartup = useCallback((): Promise<void> => {
    setRetryingStartup(true);
    return window.wanigan.startup.retry()
      .then((state) => { setStartup(state); })
      .finally(() => setRetryingStartup(false));
  }, []);

  const retryStartupFromBanner = useCallback(() => {
    void retryStartup().catch((e) =>
      reportError(e, { label: 'Retry local services', run: retryStartup }));
  }, [reportError, retryStartup]);

  // ── motion setting ─────────────────────────────────────────────────
  // Published on the root element so CSS can answer without asking React.
  const loadMotion = useCallback(async () => {
    let m: MotionSetting = 'auto';
    try { m = (await window.wanigan.prefs.all()).motion ?? 'auto'; } catch { /* db not ready */ }
    document.documentElement.dataset.motion = m;
  }, []);

  useEffect(() => { void loadMotion(); }, [loadMotion, tab]);

  useEffect(() => {
    const again = () => void loadMotion();
    window.addEventListener('focus', again);
    window.addEventListener('wanigan:prefs-changed', again);
    return () => {
      window.removeEventListener('focus', again);
      window.removeEventListener('wanigan:prefs-changed', again);
    };
  }, [loadMotion]);

  // ── nav counts ─────────────────────────────────────────────────────
  // Badges are polled centrally so a blocked agent or a running batch is
  // visible from whichever view you happen to be in. A failing endpoint zeroes
  // its own badge rather than blanking the others.
  const tick = useCallback(async () => {
    const [ss, runs, att] = await Promise.all([
      window.wanigan.sessions.list().catch(() => [] as Session[]),
      window.wanigan.batch.runs().catch(() => [] as { status: string }[]),
      window.wanigan.attention.list().catch(() => [] as Attention[]),
    ]);
    // Poll results are only allowed to re-render the app when they actually
    // differ — a new array every six seconds would re-render the view holding
    // the terminals for nothing.
    setSessions((prev) => (shape(prev) === shape(ss) ? prev : ss));

    type RunRow = { status: string; succeeded?: number; failed?: number; pending?: number };
    const flying = (runs as RunRow[]).filter((r) =>
      ['in_progress', 'submitting', 'canceling'].includes(r.status));
    setActiveRuns(flying.length);
    let returned = 0, submitted = 0;
    for (const r of flying) {
      const ok = Number(r.succeeded) || 0, bad = Number(r.failed) || 0, wait = Number(r.pending) || 0;
      returned += ok + bad; submitted += ok + bad + wait;
    }
    // Nothing to show until the API has actually accepted rows; a bar at zero
    // width for a run that has not been submitted yet would be a guess.
    setBatchWork((prev) => {
      if (submitted <= 0) return prev === null ? prev : null;
      if (prev && prev.done === returned && prev.total === submitted) return prev;
      return { done: returned, total: submitted };
    });

    const live = new Set(ss.map((s) => s.id));
    const byKind = new Map<AttentionKind, number>();
    for (const a of att) {
      if (!live.has(a.sessionId) || !NEEDS_YOU.includes(a.kind)) continue;
      byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
    }
    const total = [...byKind.values()].reduce((x, y) => x + y, 0);
    const worst = NEEDS_YOU.find((k) => (byKind.get(k) ?? 0) > 0) ?? null;
    const detail = NEEDS_YOU
      .filter((k) => (byKind.get(k) ?? 0) > 0)
      .map((k) => NEED_MARK[k].phrase(byKind.get(k) ?? 0))
      .join(' · ');
    setNeeds((prev) =>
      (prev.total === total && prev.worst === worst && prev.detail === detail)
        ? prev : { total, worst, detail });
  }, []);

  useEffect(() => {
    void tick();
    const t = setInterval(tick, 6000);
    const offBatch = window.wanigan.on.batchChanged(() => void tick());
    const offList = window.wanigan.on.sessions((list) =>
      setSessions((prev) => (shape(prev) === shape(list) ? prev : list)));
    return () => { clearInterval(t); offBatch(); offList(); };
  }, [tick]);

  // Branches move constantly; keep the shared project list honest.
  useEffect(() => {
    const t = setInterval(() => {
      window.wanigan.projects.refresh().then(setProjects).catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  // A project added from another surface (or over IPC) must not stay invisible
  // to Context/Learning until the 30s branch tick: refresh on window focus and
  // whenever one of the project-reading views comes on screen.
  useEffect(() => {
    const onFocus = () => { void loadShell().catch(() => {}); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadShell]);
  useEffect(() => {
    if (tab === 'context' || tab === 'learning') void loadShell().catch(() => {});
  }, [tab, loadShell]);

  // ── the shared selection ───────────────────────────────────────────
  // If the session we were pointing at is gone, fall back to the newest live
  // one rather than handing a dead id to a session-aware surface.
  useEffect(() => {
    setActiveSessionId((cur) => {
      if (cur && sessions.some((s) => s.id === cur)) return cur;
      const up = sessions.filter((s) => s.status === 'running');
      return (up[up.length - 1] ?? sessions[sessions.length - 1])?.id ?? null;
    });
  }, [sessions]);

  const choose = useCallback((id: string) => {
    setPicked(id);
    localStorage.setItem('wanigan.project', id);
  }, []);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null, [sessions, activeSessionId]);

  // Main cannot infer which pane the renderer is showing. Keep its suppression
  // target current so the Mac does not show a redundant banner for the session
  // already on screen. Phone alerts are a separate opt-in sink and are never
  // suppressed merely because this desktop window remains focused.
  useEffect(() => {
    void window.wanigan.notify
      .setWatchedSession(tab === 'sessions' ? activeSessionId : null)
      .catch(() => {});
  }, [tab, activeSessionId]);
  useEffect(() => () => {
    void window.wanigan.notify.setWatchedSession(null).catch(() => {});
  }, []);

  const projectId = useMemo(() => {
    const known = (id?: string | null) => (id && projects.some((p) => p.id === id) ? id : undefined);
    return known(picked) ?? known(activeSession?.projectId) ?? projects[0]?.id;
  }, [picked, activeSession, projects]);

  // ── view switching ─────────────────────────────────────────────────
  const go = useCallback((next: Tab) => {
    if (next === tabRef.current) return;
    const swap = () => setTab(next);
    const doc = document as ViewTransitionDoc;
    // A live PTY on either side of the swap means no transition at all.
    const touchesPty =
      (next === 'sessions' || tabRef.current === 'sessions') && sessionsRef.current.length > 0;
    if (touchesPty || !motionOn() || typeof doc.startViewTransition !== 'function') { swap(); return; }
    doc.startViewTransition(() => { flushSync(swap); });
  }, []);

  // One-shot deep link into the Learning view: Context's "set in Learning →
  // Optimize" prose becomes a real door. Consumed by nonce, like newSessionRequest.
  const [learningTarget, setLearningTarget] = useState<{ tab: 'overview' | 'inbox' | 'knowledge' | 'optimize'; nonce: number } | null>(null);
  const openLearning = useCallback((target: 'overview' | 'inbox' | 'knowledge' | 'optimize') => {
    setLearningTarget({ tab: target, nonce: Date.now() });
    go('learning');
  }, [go]);

  // Goal links are intentionally portable: another Wanigan window (or a
  // pasted link while this one is already open) should switch to Control
  // before Control reads the fragment. `replaceState` used inside Control
  // does not emit hashchange, so this never fights an in-place selection.
  useEffect(() => {
    const onHashChange = () => {
      try {
        if (new URLSearchParams(window.location.hash.slice(1)).get('goal')) go('control');
      } catch { /* malformed fragments stay ordinary navigation state */ }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [go]);

  const requestNewSession = useCallback(() => {
    setNewSessionRequest((previous) => (previous ?? 0) + 1);
    go('sessions');
  }, [go]);

  const consumeNewSessionRequest = useCallback(() => {
    setNewSessionRequest(null);
  }, []);

  const openPalette = useCallback(() => {
    const active = document.activeElement;
    paletteOpenerRef.current = active instanceof HTMLElement ? active : null;
    setPaletteQuery('');
    setPalette(true);
  }, []);

  const closePalette = useCallback((restoreFocus = true) => {
    setPalette(false);
    setPaletteQuery('');
    if (!restoreFocus) return;
    const opener = paletteOpenerRef.current;
    requestAnimationFrame(() => opener?.focus());
  }, []);

  const openSession = useCallback((id: string) => {
    setActiveSessionId(id);
    const s = sessionsRef.current.find((x) => x.id === id);
    if (s) choose(s.projectId);
    go('sessions');
  }, [choose, go]);

  /** Scout proposals become durable Control Goals. Set the portable fragment
   * and move to the owning surface together; a fragment alone has no visible
   * effect while another tab is mounted. */
  const openGoal = useCallback((id: string) => {
    window.history.replaceState(null, '', `#goal=${encodeURIComponent(id)}`);
    go('control');
  }, [go]);

  const focusSession = useCallback((id: string, projectId?: string) => {
    setActiveSessionId(id);
    const project = projectId ?? sessionsRef.current.find((x) => x.id === id)?.projectId;
    if (project) choose(project);
  }, [choose]);

  // ⌘1–9. Capture phase, because Sessions binds ⌘1–9 to its own tabs and only
  // one of us can win; inside a terminal neither of us takes the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.length !== 1) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest('.terminal-host')) return;          // the PTY owns its keystrokes
      if (document.querySelector('.modal-backdrop, .command-backdrop')) return;  // a dialog owns the keyboard
      // New work should be available from every surface, not only after a
      // detour back to Sessions. The terminal still owns this shortcut while
      // it has focus, just as it owns the number keys below.
      if (e.key.toLowerCase() === 't') {
        e.preventDefault();
        e.stopPropagation();
        requestNewSession();
        return;
      }
      // Runs is the tenth surface. It deserves a direct route rather than
      // being the only tab that disappears once the header overflows.
      if (e.key === '0') {
        e.preventDefault();
        e.stopPropagation();
        go('runs');
        return;
      }
      // The key every Mac user already tries for preferences. Settings sits
      // past the digit row, so without this it had no direct route at all.
      if (e.key === ',') {
        e.preventDefault();
        e.stopPropagation();
        go('settings');
        return;
      }
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > TABS.length) return;
      e.preventDefault();
      e.stopPropagation();
      go(TABS[n - 1].id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [go, requestNewSession]);

  // A tab strip has a finite width; the command palette does not. It is the
  // keyboard route to every surface, not a second hidden navigation system.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k') return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest('.terminal-host') || document.querySelector('.modal-backdrop')) return;
      e.preventDefault();
      if (palette) closePalette();
      else openPalette();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [closePalette, openPalette, palette]);

  // Split from addProject so the failure can hand the toast the same work to
  // run again; a callback that reported its own failure could not be its retry.
  const pickProject = useCallback(async () => {
    const p = await window.wanigan.projects.pick();
    if (p) { setProjects(await window.wanigan.projects.list()); choose(p.id); }
  }, [choose]);

  const addProject = useCallback(async () => {
    try { await pickProject(); }
    catch (e) { reportError(e, { label: 'Choose a folder again', run: pickProject }); }
  }, [pickProject, reportError]);

  const removeProject = useCallback(async (id: string) => {
    setProjects(await window.wanigan.projects.remove(id));
  }, []);

  // ── nav chrome ─────────────────────────────────────────────────────
  const tabsRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  const runBadge = useRef<HTMLSpanElement>(null);
  const needBadge = useRef<HTMLSpanElement>(null);
  const lastNeeds = useRef(0);

  // The visible strip behaves like a compact toolbar. Tab enters it once, and
  // Left/Right (or Home/End) walks every visible route without asking a
  // keyboard user to tab through eleven tiny controls.
  //
  // Arrowing moves FOCUS and nothing else. Selection-follows-focus in a
  // toolbar mounts and unmounts a whole view per keypress, and with a live
  // terminal on either side of the swap that is a PTY pane torn down and
  // rebuilt to read a nav label. Enter or Space is the switch, as on any
  // other button in the app.
  const onNavTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, current: Tab) => {
    const currentIndex = NAV_RAIL_TABS.indexOf(current);
    if (currentIndex < 0) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % NAV_RAIL_TABS.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + NAV_RAIL_TABS.length) % NAV_RAIL_TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = NAV_RAIL_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = NAV_RAIL_TABS[nextIndex];
    setNavFocus(next);
    requestAnimationFrame(() => {
      tabsRef.current?.querySelector<HTMLButtonElement>(`[data-nav-tab="${next}"]`)?.focus();
    });
  }, []);

  // A view reached any other way (a shortcut, the palette, a deep link) takes
  // the tab stop back, so Tab always re-enters the rail at the view on screen.
  useEffect(() => { setNavFocus(null); }, [tab]);

  // The underline is placed from measured geometry, so it can slide on the
  // compositor instead of the browser re-laying out a border every frame.
  useEffect(() => {
    const wrap = tabsRef.current, ink = inkRef.current;
    if (!wrap || !ink) return;
    const place = () => {
      const on = wrap.querySelector<HTMLElement>('.nav-tab.on');
      if (!on || !on.offsetWidth) { wrap.classList.remove('has-ink'); return; }
      // The tabs intentionally scroll rather than compressing into unreadable
      // labels. Keep the destination in view when it was reached by keyboard
      // or a quick action, because an invisible scrollbar is not navigation.
      on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (!placed.current) { ink.style.transition = 'none'; }
      ink.style.transform = `translateX(${on.offsetLeft}px) scaleX(${on.offsetWidth})`;
      wrap.classList.add('has-ink');
      if (!placed.current) {
        placed.current = true;
        requestAnimationFrame(() => { ink.style.transition = ''; });
      }
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [tab, running, activeRuns, needs.total, hasKey, projects.length]);

  // The Sessions badge breathes at the rate output actually arrives — measured
  // bytes per second, never a spinner that implies work nobody is doing.
  useEffect(() => {
    let bytes = 0;
    const off = window.wanigan.on.data(({ data }) => { bytes += data.length; });
    const t = setInterval(() => {
      const el = runBadge.current;
      const seen = bytes; bytes = 0;
      if (!el) return;
      if (seen <= 0) { el.removeAttribute('data-flow'); el.style.removeProperty('--mo-period'); return; }
      const period = Math.round(Math.min(2600, Math.max(700, 1_600_000 / seen)));
      el.style.setProperty('--mo-period', `${period}ms`);
      el.dataset.flow = 'live';
    }, 1000);
    return () => { off(); clearInterval(t); };
  }, []);

  // One bump per agent that newly needs you. Counts, not a heartbeat.
  useEffect(() => {
    const el = needBadge.current;
    if (el && needs.total > lastNeeds.current && motionOn()) {
      el.classList.remove('mo-bump');
      void el.offsetWidth;
      el.classList.add('mo-bump');
    }
    lastNeeds.current = needs.total;
  }, [needs.total]);

  const mark = needs.worst ? NEED_MARK[needs.worst] : null;
  const railHasActiveTab = NAV_RAIL_TABS.includes(tab);
  const navRoving: Tab = navFocus && NAV_RAIL_TABS.includes(navFocus)
    ? navFocus
    : (railHasActiveTab ? tab : NAV_RAIL_TABS[0]);

  // ── demo mode ───────────────────────────────────────────
  // Read once at start-up. demo:set reloads the window, so there is no state
  // to keep in sync afterwards — the next mount reads the new answer.
  useEffect(() => {
    let mounted = true;
    const read = () => window.wanigan.demo.state().then((s) => { if (mounted) setDemoOn(s.on); });
    void read().catch((e) => {
      // A silent failure here would be the one failure this app cannot take:
      // masking on, and nothing on screen saying the names are invented.
      if (mounted) reportError(e, { label: 'Check whether demo mode is on', run: read }, 'settings');
    });
    return () => { mounted = false; };
  }, [reportError]);

  const applyDemo = useCallback((next: boolean) => {
    setDemoBusy(true);
    void window.wanigan.demo.set(next)
      .then(() => window.location.reload())
      .catch((e) => {
        setDemoBusy(false);
        setDemoPrompt(null);
        reportError(e, undefined, 'settings');
      });
  }, [reportError]);

  // ⌘⇧ chords. ⌘⇧D still reaches demo mode from anywhere — a toggle you have
  // to go and find is one you forget until after the screenshot — but it now
  // asks first: a mistyped chord used to rewrite every project name on screen
  // and reload the window with no confirmation and no way back but retyping it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest('.terminal-host')) return;                              // the PTY owns its keystrokes
      if (document.querySelector('.modal-backdrop, .command-backdrop')) return;  // a dialog owns the keyboard
      const key = e.key.toLowerCase();
      if (key === 'd') {
        e.preventDefault();
        e.stopPropagation();
        setDemoPrompt({ next: !demoOn });
        return;
      }
      const chord = SHIFT_CHORD_TABS[key];
      if (!chord) return;
      e.preventDefault();
      e.stopPropagation();
      go(chord);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [demoOn, go]);

  // Escape dismisses the shell error, matching every other overlay here. It
  // stays out of the way of a terminal and of anything more modal than itself.
  useEffect(() => {
    if (!error) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest('.terminal-host')) return;
      if (document.querySelector('.modal-backdrop, .command-backdrop')) return;
      setError(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [error]);

  /**
   * Everything ⌘K can reach. The static view list alone made the palette a
   * second copy of the nav; the two things an operator actually searches for
   * by name — a repository and a running agent — were the two it could not
   * find. Sessions are filtered to the live ones: an exited session is a
   * record, and Fleet and the session rail are where records are read.
   */
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [{
      key: 'action:new-session',
      title: 'New session',
      hint: 'Start an interactive agent',
      meta: '⌘T',
      primary: true,
      haystack: 'new session start agent interactive terminal',
      run: requestNewSession,
    }];
    for (const item of TABS) {
      items.push({
        key: `view:${item.id}`,
        title: item.label,
        hint: `${item.group} view`,
        meta: TAB_SHORTCUTS[item.id].label,
        haystack: `${item.label} ${item.group} ${item.keywords}`,
        run: () => go(item.id),
      });
    }
    for (const s of sessions) {
      if (s.status === 'exited') continue;
      items.push({
        key: `session:${s.id}`,
        title: s.title || s.projectName,
        hint: `${s.status} · ${s.projectName}${s.model ? ` · ${s.model}` : ''}`,
        meta: 'Session',
        haystack: `${s.title} ${s.projectName} ${s.providerId} ${s.model ?? ''} session agent`,
        run: () => openSession(s.id),
      });
    }
    for (const p of projects) {
      items.push({
        key: `project:${p.id}`,
        title: p.name,
        // Says exactly what pressing it does. Choosing a project moves no view,
        // so a row promising to "open" one would be describing something else.
        hint: `Make active for Learning, Context and Skills${p.branch ? ` · ${p.branch}` : ''}`,
        meta: 'Project',
        staysPut: true,
        haystack: `${p.name} ${p.path} ${p.branch ?? ''} project repository folder`,
        run: () => choose(p.id),
      });
    }
    return items;
  }, [choose, go, openSession, projects, requestNewSession, sessions]);

  return (
    <div className="shell">
      {startup?.phase === 'recovery' && (
        <section className="startup-recovery" role="alert" aria-live="assertive">
          <div>
            <strong>Wanigan is open in recovery mode.</strong>
            <span>{startup.stage ?? 'Startup'}: {startup.message ?? 'Unknown local-data error.'}</span>
            <small>No data was changed by this recovery screen. Fix the local-data issue, then retry or restart Wanigan.</small>
          </div>
          <button className="btn" type="button" onClick={retryStartupFromBanner} disabled={retryingStartup}>
            {retryingStartup ? 'Retrying…' : 'Retry local services'}
          </button>
        </section>
      )}
      {/* Demo mode replaces real names before they ever reach this window, so
          nothing downstream can tell you it is on. It borrows the recovery
          strip's shape deliberately: a persistent band above the header is the
          one place a masked screenshot cannot crop it out by accident. */}
      {demoOn && (
        <section className="startup-recovery demo-banner" role="status">
          <div>
            <strong>Demo mode is on — the names on screen are masked.</strong>
            <span>
              Project names, paths, your username, git authors and email addresses are replaced with
              stand-ins before any response reaches this window. Counts, costs and timings are not masked.
            </span>
            <small>Turn it off here, in Settings › App, or with ⌘⇧D.</small>
          </div>
          <button className="btn" type="button" onClick={() => setDemoPrompt({ next: false })}>
            Turn off demo mode
          </button>
        </section>
      )}
      <header className="app-header">
        <div className="nav-titlebar">
          <div className="brand-lockup">
            <span className="brand">Wanigan</span>
            <span className="brand-context">Agent control center</span>
          </div>

          <div className="nav-actions">
            {/* The Learning view owns its scope control now — a nav-level
                project select that only sometimes rendered was the invisible
                scope that let two surfaces state contradictory counts. */}

            <button className="nav-new-session" type="button" onClick={requestNewSession}
                    title="Start a new interactive agent session (⌘T)"
                    aria-label="Start a new interactive agent session (Command T)">
              <span className="nav-new-session-plus" aria-hidden="true">+</span>
              <span className="nav-new-session-label">New session</span>
              <span className="nav-shortcut" aria-hidden="true">⌘T</span>
            </button>

            {/* One label, one shortcut, one surface. This button used to open a
                dropdown while ⌘K — the shortcut printed on it — opened the
                palette instead: the same promise leading to two different
                lists. The palette wins, because it is the one that can search
                projects and live sessions as well as views.

                When the view on screen is off the rail, the button stops
                saying "Views" and names it with a ✓. index.css styles :hover,
                aria-expanded and .on identically, so the current view has to
                be legible from the text rather than the highlight. */}
            <div className="nav-views">
              <button className={`nav-views-button${railHasActiveTab ? '' : ' on'}`} type="button"
                      aria-haspopup="dialog" aria-expanded={palette}
                      aria-current={railHasActiveTab ? undefined : 'page'}
                      aria-keyshortcuts="Meta+K Control+K"
                      title={railHasActiveTab
                        ? 'Search every view, project and live session (⌘K)'
                        : `${labelForTab(tab)} is the view on screen — search every view, project and live session (⌘K)`}
                      aria-label={railHasActiveTab
                        ? 'Search every view, project and live session (Command K)'
                        : `${labelForTab(tab)} is the view on screen. Search every view, project and live session (Command K)`}
                      onClick={() => (palette ? closePalette() : openPalette())}>
                {railHasActiveTab
                  ? <span>Views</span>
                  : <span><span aria-hidden="true">✓ </span>{labelForTab(tab)}</span>}
                <span className="nav-views-shortcut" aria-hidden="true">⌘K</span>
              </button>
            </div>

            <button className="nav-quick-run" type="button" onClick={() => go('runs')}
                    title="Open headless Runs (⌘0)">
              <span className="nav-quick-run-plus" aria-hidden="true">+</span>
              <span className="nav-quick-run-headless">Headless</span>
              <span>runs</span>
              <span className="nav-shortcut" aria-hidden="true">⌘0</span>
            </button>

            {activeSession && <ProviderUsageBadge session={activeSession} providers={providers} />}
            <ThemeControl preference={theme.preference} resolved={theme.resolved} onChange={theme.setTheme} />
          </div>
        </div>

        <nav className="nav" aria-label="Primary navigation">
          <div className="nav-tabs" ref={tabsRef} role="toolbar" aria-label="Wanigan views">
            <NavTab id="sessions" tab={tab} go={go} label="Sessions" roving={navRoving} onKeyDown={onNavTabKeyDown}>
              {running > 0 && (
                <span className="nav-badge mo-breathe" ref={runBadge}
                      title={`${running} session${running === 1 ? '' : 's'} running`}>{running}</span>
              )}
            </NavTab>
            <NavTab id="fleet" tab={tab} go={go} label="Fleet" roving={navRoving} onKeyDown={onNavTabKeyDown}>
              {mark && (
                <span className={`nav-mark tone-${mark.tone}`} ref={needBadge}
                      title={`${needs.detail} — open Fleet (⌘2)`}>
                  <span aria-hidden="true">{mark.glyph}</span>{needs.total} need you
                </span>
              )}
            </NavTab>
            <NavTab id="control" tab={tab} go={go} label="Control" roving={navRoving} onKeyDown={onNavTabKeyDown} />
            <NavTab id="batches" tab={tab} go={go} label="Batches" roving={navRoving} onKeyDown={onNavTabKeyDown}>
              {/* The API key gates batch submission and nothing else. On the
                  Settings tab it was a permanent warning that read as "Wanigan
                  is not set up", from every screen, while Sessions, Fleet,
                  Control, Runs, Learning, Git and Schedules all work without
                  one. It belongs on the surface it is actually true about. */}
              {!hasKey && (
                <span className="nav-mark tone-warn"
                      title="Batch submission needs an API key — add one in Settings. Interactive sessions, Fleet, Control, Runs, Learning, Git and Schedules do not need it."
                      aria-label="Batch submission needs an API key. Add one in Settings. Interactive sessions, Fleet, Control, Runs, Learning, Git and Schedules do not need it.">
                  <span aria-hidden="true">!</span>needs key
                </span>
              )}
              {activeRuns > 0 && (
                <span className="nav-badge"
                      title={`${activeRuns} batch run${activeRuns === 1 ? '' : 's'} in flight`}>{activeRuns}</span>
              )}
              {batchWork && (
                <span className="nav-progress" role="progressbar" aria-valuemin={0} aria-valuemax={batchWork.total}
                      aria-valuenow={batchWork.done}
                      title={`${num(batchWork.done)} of ${num(batchWork.total)} requests returned`}>
                  <span className="mo-fill"
                        style={{ '--mo-p': batchWork.done / batchWork.total } as React.CSSProperties} />
                </span>
              )}
            </NavTab>
            <NavTab id="insights" tab={tab} go={go} label="Insights" roving={navRoving} onKeyDown={onNavTabKeyDown} />
            <NavTab id="learning" tab={tab} go={go} label="Learning" roving={navRoving} onKeyDown={onNavTabKeyDown} />
            <NavTab id="plugins"  tab={tab} go={go} label="Plugins" roving={navRoving} onKeyDown={onNavTabKeyDown} />
            <NavTab id="schedules" tab={tab} go={go} label="Schedules" roving={navRoving} onKeyDown={onNavTabKeyDown} />
            <NavTab id="git"      tab={tab} go={go} label="Git" roving={navRoving} onKeyDown={onNavTabKeyDown} />
            <NavTab id="runs"     tab={tab} go={go} label="Runs" roving={navRoving} onKeyDown={onNavTabKeyDown} />
            <NavTab id="settings" tab={tab} go={go} label="Settings" roving={navRoving} onKeyDown={onNavTabKeyDown} />
            <span className="nav-ink" ref={inkRef} aria-hidden="true" />
          </div>
        </nav>
      </header>

      {/* The boundary sits here and not around the shell: a view that cannot
          render must not take the header, the rail or ⌘K with it. `view={tab}`
          means leaving a broken surface clears the fallback by itself. */}
      <div className="body">
        <ErrorBoundary view={tab} label={labelForTab(tab)}>
          {tab === 'sessions' && (
            <Sessions providers={providers} projects={projects}
                      onAddProject={addProject} onError={reportSessionError}
                      activeId={activeSessionId} onActiveChange={focusSession}
                      newSessionRequest={newSessionRequest} onNewSessionRequestConsumed={consumeNewSessionRequest}
                      onSendToBatch={(seed) => { setBatchSeed(seed); go('batches'); }} />
          )}
          {tab === 'fleet' && <Fleet projects={projects} onOpenSession={openSession} />}
          {tab === 'control' && <Control projects={projects} providers={providers} onOpenSession={openSession} />}
          {tab === 'batches' && (
            <Batches projects={projects} hasKey={hasKey} onNeedKey={() => go('settings')}
                     seed={batchSeed} onSeedConsumed={() => setBatchSeed(null)} />
          )}
          {tab === 'insights' && <InsightsView />}
          {tab === 'learning' && (
            <Learning projectId={projectId} projects={projects} providers={providers} onOpenGoal={openGoal}
                      onPickProject={choose} initialTarget={learningTarget} />
          )}
          {tab === 'skills' && <Skills projectId={projectId} activeSessionId={activeSessionId} />}
          {tab === 'context' && (
            <Context projectId={projectId} projects={projects}
                     onReloadProjects={loadShell} onOpenLearning={openLearning} />
          )}
          {tab === 'plugins' && <Plugins />}
          {tab === 'schedules' && <Schedules projects={projects} />}
          {tab === 'git' && <Git projects={projects} />}
          {tab === 'runs' && <HeadlessRuns projects={projects} providers={providers} />}
          {tab === 'settings' && (
            <SettingsView providers={providers} projects={projects}
                          onKeyChange={loadShell} onRemoveProject={removeProject} onAddProject={addProject}
                          themePreference={theme.preference} resolvedTheme={theme.resolved} onThemeChange={theme.setTheme} />
          )}
        </ErrorBoundary>
      </div>

      {error && (
        <div className="toast" role="alert" aria-live="assertive">
          <div>{error.message}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {error.retry && (
              <button className="btn btn-primary" type="button" onClick={runErrorRetry} disabled={retryingError}>
                {retryingError ? 'Retrying…' : error.retry.label}
              </button>
            )}
            {error.goTo && error.goTo !== tab && (
              <button className="btn" type="button" style={{ color: 'var(--text)' }}
                      onClick={() => { const to = error.goTo; setError(null); if (to) go(to); }}>
                Open {labelForTab(error.goTo)}
              </button>
            )}
            <button className="btn" type="button" style={{ color: 'var(--text)' }} onClick={() => setError(null)}>
              Dismiss
            </button>
            <span className="faint" style={{ alignSelf: 'center', fontSize: 'var(--t-micro)' }}>Esc closes</span>
          </div>
        </div>
      )}
      {palette && (
        <CommandPalette
          query={paletteQuery}
          onQuery={setPaletteQuery}
          items={paletteItems}
          onClose={closePalette}
          onRun={(item) => { closePalette(item.staysPut === true); item.run(); }}
        />
      )}
      {demoPrompt && (
        <div className="modal-backdrop" role="presentation"
             onMouseDown={() => { if (!demoBusy) setDemoPrompt(null); }}>
          <DemoConfirm next={demoPrompt.next} busy={demoBusy}
                       onCancel={() => setDemoPrompt(null)}
                       onConfirm={() => applyDemo(demoPrompt.next)} />
        </div>
      )}
    </div>
  );
}

/**
 * Demo mode is the one toggle in Wanigan that makes the app state something
 * untrue on purpose, and ⌘⇧D now sits one key from the ⌘⇧S that opens Skills.
 * Ask first, and say what changes — including that the window reloads, which
 * is alarming if an agent is running and harmless once you know where the
 * process actually lives.
 */
function DemoConfirm({ next, busy, onCancel, onConfirm }: {
  next: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { confirmRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return;
      e.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onCancel]);
  return (
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="wanigan-demo-title"
             onMouseDown={(e) => e.stopPropagation()}>
      <h2 id="wanigan-demo-title" style={{ fontSize: 'var(--t-title)', fontWeight: 600 }}>
        {next ? 'Turn on demo mode?' : 'Turn off demo mode?'}
      </h2>
      <p className="dim" style={{ marginTop: 8, lineHeight: 1.55 }}>
        {next
          ? 'Every response is rewritten before it reaches the window: project names, paths, your username, git authors and email addresses become stand-ins. What you read and screenshot afterwards is masked, not observed.'
          : 'Wanigan will show real project names, paths, your username and git authors again.'}
      </p>
      <p className="faint" style={{ marginTop: 8, lineHeight: 1.5 }}>
        Applying this reloads the window. Agent processes run outside it, so a running session is not
        stopped and its terminal reattaches with its scrollback. A banner above the header stays on
        screen for as long as demo mode is on.
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button className="btn" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button ref={confirmRef} className="btn btn-primary" type="button" onClick={onConfirm} disabled={busy}>
          {busy ? 'Applying…' : next ? 'Turn on and reload' : 'Turn off and reload'}
        </button>
      </div>
    </section>
  );
}

/**
 * A selected-session status, rather than a global "Codex is installed" badge.
 * Codex can honestly report account windows; other providers receive only
 * their own session telemetry until they expose an equivalent account reader.
 */
function ProviderUsageBadge({ session, providers }: { session: Session; providers: ProviderInfo[] }) {
  const context = useMemo(() => selectedProviderStatus(session, providers), [providers, session]);
  const [status, setStatus] = useState<{ key: string; value: CodexStatus } | null>(null);
  const [usage, setUsage] = useState<{ key: string; value: Awaited<ReturnType<typeof window.wanigan.usage.session>> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  // An account-status reply can arrive after the operator changes sessions.
  // Epochs make that stale reply a no-op instead of relabelling Claude as Codex.
  const requestEpoch = useRef(0);
  // Read off the context rather than through it: every hook below has to run
  // unconditionally, so it must survive a null context instead of standing
  // behind an early return. See the guard after the hooks.
  const contextKey = context?.key ?? null;
  const usesCodexAccountLimits = context?.usesCodexAccountLimits ?? false;
  const load = useCallback((force = false) => {
    const key = contextKey;
    if (!key) return;
    const epoch = ++requestEpoch.current;
    setLoadingKey(key);
    setError(null);
    const done = () => {
      if (epoch === requestEpoch.current) setLoadingKey(null);
    };
    if (usesCodexAccountLimits) {
      void window.wanigan.codex.status(force).then((next) => {
        if (epoch !== requestEpoch.current) return;
        setStatus({ key, value: next });
      }).catch((e) => {
        if (epoch !== requestEpoch.current) return;
        setError(e instanceof Error ? e.message : String(e));
      }).finally(done);
      return;
    }
    void window.wanigan.usage.session(session.id).then((next) => {
      if (epoch !== requestEpoch.current) return;
      setUsage({ key, value: next });
    }).catch((e) => {
      if (epoch !== requestEpoch.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }).finally(done);
  }, [contextKey, usesCodexAccountLimits, session.id]);
  useEffect(() => {
    // Clear the previous provider synchronously at the effect boundary. The
    // keyed reads below are the second guard against an async race.
    setStatus(null);
    setUsage(null);
    if (!contextKey) return;
    load();
    const timer = window.setInterval(() => load(), 60_000);
    return () => {
      requestEpoch.current += 1;
      window.clearInterval(timer);
    };
  }, [contextKey, load]);

  /*
   * The parent calls us only for a real session, so this is unreachable today
   * — and it stays, because falling back to an unrelated account status is a
   * worse failure than rendering nothing. It sits below every hook on purpose:
   * as an early return above them it was one reuse away from "rendered more
   * hooks than during the previous render", which until the view boundary
   * landed took the whole window with it.
   */
  if (!context) return null;

  const label = (window: CodexStatus['primary'], short: string) => {
    if (!window) return null;
    const reset = window.resetsAt ? ` · resets ${relativeReset(window.resetsAt)}` : '';
    return `${short} ${window.remainingPercent}% left${reset}`;
  };
  const codex = status?.key === context.key ? status.value : null;
  const sessionUsage = usage?.key === context.key ? usage.value : null;
  const primary = label(codex?.primary ?? null, 'Now');
  const secondary = label(codex?.secondary ?? null, 'Week');
  const telemetry = selectedSessionTelemetry(sessionUsage, session.status);
  const loading = loadingKey === context.key;
  const sessionLine = `${context.label} · selected ${session.status} session${session.model ? ` · ${session.model}` : ''}`;
  const title = error
    ? `${sessionLine}\nStatus unavailable: ${error}\nClick to refresh this selected session.`
    : context.usesCodexAccountLimits
      ? [sessionLine, `Codex ${codex?.plan ?? 'account'} limits`, primary, secondary,
        'Account limits are shared across Codex sessions. Click to refresh now.'].filter(Boolean).join('\n')
      : [sessionLine, `Session telemetry: ${telemetry}.`,
        'This provider does not expose account-plan remaining or reset time to Wanigan, so no quota is invented.',
        'Click to refresh this selected session.'].join('\n');
  const visible = context.usesCodexAccountLimits
    ? primary ?? (loading ? 'limits…' : 'Status unavailable')
    : error ? 'usage unavailable' : loading && !sessionUsage ? 'session…' : telemetry;

  return (
    <button className={`nav-usage-status${codex?.primary && codex.primary.remainingPercent <= 20 ? ' low' : ''}`}
            title={title} aria-label={title} onClick={() => load(true)}>
      <span className="faint">{context.label}</span> {visible}
      {context.usesCodexAccountLimits && secondary && <span className="nav-usage-week">· {secondary}</span>}
    </button>
  );
}

function relativeReset(at: number): string {
  const mins = Math.max(0, Math.round((at - Date.now()) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * One row of the command palette. The palette is the only complete index of
 * this app, so its corpus is built by the shell — which is the only thing that
 * knows the open projects and the live sessions — and this component just
 * renders and drives it.
 */
type PaletteItem = {
  key: string;
  title: string;
  hint: string;
  /** Right-hand column: a shortcut where one exists, otherwise what this is. */
  meta: string;
  haystack: string;
  primary?: boolean;
  /** True when running this leaves the view alone, so focus has to go back to
   *  whatever opened the palette rather than falling to the document body. */
  staysPut?: boolean;
  run: () => void;
};

function CommandPalette({ query, onQuery, items, onClose, onRun }: {
  query: string; onQuery: (value: string) => void; items: PaletteItem[];
  onClose: () => void; onRun: (item: PaletteItem) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const shown = useMemo(
    () => items.filter((item) => `${item.title} ${item.hint} ${item.haystack}`.toLocaleLowerCase().includes(normalizedQuery)),
    [items, normalizedQuery]);
  // Reaching the third result used to take three Tabs. One highlighted row,
  // moved with the arrow keys and taken with Enter, is what every palette on
  // this machine does; anything else is a list you have to walk.
  const [selected, setSelected] = useState(0);
  const active = shown.length === 0 ? -1 : Math.min(selected, shown.length - 1);
  useEffect(() => { setSelected(0); }, [normalizedQuery]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-command-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((item) => item.getClientRects().length > 0);
      if (focusable.length === 0) { e.preventDefault(); return; }
      const activeEl = document.activeElement;
      const index = activeEl instanceof HTMLElement ? focusable.indexOf(activeEl) : -1;
      if (e.shiftKey && index <= 0) { e.preventDefault(); focusable[focusable.length - 1]?.focus(); }
      if (!e.shiftKey && (index < 0 || index === focusable.length - 1)) { e.preventDefault(); focusable[0]?.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Bound on the dialog so the arrows keep working after Tab has moved focus
  // onto a row. Focus itself stays in the field: the highlight is published
  // with aria-activedescendant, so typing never stops mid-search.
  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (shown.length === 0) return;
    const step = (delta: number) => {
      e.preventDefault();
      setSelected((current) => {
        const from = Math.min(current, shown.length - 1);
        return (from + delta + shown.length) % shown.length;
      });
      input.current?.focus();
    };
    if (e.key === 'ArrowDown') return step(1);
    if (e.key === 'ArrowUp') return step(-1);
    if (e.key === 'Home') { e.preventDefault(); setSelected(0); input.current?.focus(); return; }
    if (e.key === 'End') { e.preventDefault(); setSelected(shown.length - 1); input.current?.focus(); return; }
    // A row that already has focus activates itself; Enter is only ours while
    // the caret is still in the field.
    if (e.key === 'Enter' && document.activeElement === input.current && active >= 0) {
      e.preventDefault();
      onRun(shown[active]);
    }
  };

  return (
    <div className="command-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialog} className="command-palette" role="dialog" aria-modal="true"
               aria-label="Go to a view, project or session"
               onKeyDown={onDialogKeyDown} onMouseDown={(e) => e.stopPropagation()}>
        <input ref={input} className="field" value={query} onChange={(e) => onQuery(e.target.value)}
               placeholder="Go to a view, project or live session…"
               aria-label="Search views, projects and live sessions"
               role="combobox" aria-expanded={shown.length > 0} aria-autocomplete="list"
               aria-controls="wanigan-command-results"
               aria-activedescendant={active >= 0 ? `wanigan-command-${active}` : undefined} />
        <div ref={list} id="wanigan-command-results" className="command-results" role="listbox"
             aria-label="Results">
          {shown.length === 0 ? <p className="faint">No matching view, project, session or action.</p> : shown.map((item, index) => (
            // index.css owns the hover and focus states for these rows and has no rule
            // for a keyboard highlight yet, so the highlight mirrors the same two
            // tokens inline rather than inventing a second appearance for it.
            <button key={item.key} id={`wanigan-command-${index}`} type="button" role="option"
                    className={`command-item${item.primary ? ' command-item-primary' : ''}`}
                    aria-selected={index === active} data-command-active={index === active}
                    style={index === active && !item.primary
                      ? { alignItems: 'center', background: 'var(--accent-soft)', color: 'var(--text)' }
                      : { alignItems: 'center' }}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => onRun(item)}>
              <span className="command-item-copy"><strong>{item.title}</strong><small>{item.hint}</small></span>
              <span className="faint mono">{item.meta}</span>
            </button>
          ))}
        </div>
        <p className="faint" style={{ margin: '8px 0 0', fontSize: 'var(--t-small)' }}>
          ↑↓ moves · Enter opens · Esc closes · ⌘K opens
        </p>
      </section>
    </div>
  );
}

function NavTab({ id, tab, go, label, children, onKeyDown, roving }: {
  id: Tab; tab: Tab; go: (t: Tab) => void; label: string; children?: React.ReactNode;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, current: Tab) => void;
  /** The rail's single tab stop. It follows arrow-key focus, not the view. */
  roving: Tab;
}) {
  const on = tab === id;
  const shortcut = TAB_SHORTCUTS[id];
  return (
    <button className={`nav-tab${on ? ' on' : ''}`} type="button" data-nav-tab={id}
            tabIndex={roving === id ? 0 : -1} onClick={() => go(id)} onKeyDown={(event) => onKeyDown(event, id)}
            aria-current={on ? 'page' : undefined}
            aria-keyshortcuts={shortcut.aria}
            title={`${label} (${shortcut.label})`}>
      {label}
      {children}
    </button>
  );
}
