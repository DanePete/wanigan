import { goalLocation } from '@shared/goal-journey';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Attention, AttentionKind, ClaudeContextUsage, HaltState, InAppAlert, MotionSetting, Project, ProviderInfo, Session, ThemeSetting, TranscriptHit } from '@shared/types';
import { filterPalette, groupPalette, transcriptHitRow, TRANSCRIPT_QUERY_MIN, TRANSCRIPT_RESULT_CAP, type PaletteEntry } from '@shared/palette';
import { DIGIT_ROUTES, SIDEBAR_GROUPS, TABS, TAB_ICONS, TAB_SHORTCUTS, labelForTab, type Tab } from '@shared/routes';
import { bindingMatches, inTerminal, modalOpen } from './bindings';
import Sessions from './views/Sessions';
import MissionRoom from './views/MissionRoom';
import { useContextStory } from './orb/context-story';
import CompanionPresence from './components/CompanionPresence';
import { companionPresence, type PresenceRead } from '@shared/companion-presence';
import { ProjectSpaces, SpaceRoutes, SpaceDock } from './components/SpaceNavigation';
import Fleet from './views/Fleet';
import Control from './views/Control';
import Board from './views/Board';
import Batches from './views/Batches';
import InsightsView from './views/Insights';
import Learning from './views/Learning';
import Plugins from './views/Plugins';
import Schedules from './views/Schedules';
import Git from './views/Git';
import HeadlessRuns from './views/HeadlessRuns';
import ImprovementScout from './views/ImprovementScout';
import UsageView from './views/Usage';
import SettingsView, { DemoPanel, SETTINGS_INDEX, type SettingsJump } from './views/Settings';
import Skills from './views/Skills';
import Context from './views/Context';
import { Icon, ago, num, PageHead, EmptyState, Segmented } from './components/bits';
import { DEMO_VIEWS } from '@shared/demo';
import { startTerminalOutputPump } from './components/TerminalPane';
import ErrorBoundary from './components/ErrorBoundary';
import ShortcutSheet from './components/ShortcutSheet';
import { useDialog, OVERLAY_ROOT_ID } from './components/useDialog';
import { AnnounceProvider, AnnounceRegion, type AnnounceAction } from './components/announce';
import { ViewMemoryProvider, ViewMemoryScope } from './components/viewMemory';
import { useThemePreference } from './theme';
import { claudeContextLabel, selectedProviderStatus, selectedSessionTelemetry } from '@shared/provider-status';

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
 *  - Pane transitions stay off around a live terminal. A transition that fades or
 *    slides a pane containing a running PTY fights xterm's own repaint, and the
 *    thing that ends up looking broken is the terminal. When either side of a
 *    view swap holds a live session, the swap is instant on purpose.
 *    The companion has a separate, bounded GPU loop in the footer.
 *
 * The route table (TABS, TAB_SHORTCUTS) lives in shared/routes.ts as pure
 * data, and the key table in ./bindings.ts, so the rail, the palette, the
 * cheat sheet and the handlers below read one record. ⌘1–9 still read
 * positionally out of TABS; every other chord is matched against the same
 * aria-keyshortcuts string the control publishes.
 */

// The wide rail follows the digit map: the first nine tabs are ⌘1–9 in
// order, Runs (⌘0) comes next, then the two surfaces that take named chords
// (⌘⇧U, ⌘⇧I), and Settings (⌘,) stays last. The rail used to place Usage
// beside Insights because that is where it belongs thematically — but a
// 13-tab strip cannot be both a keypad and a thematic list, and once Usage
// and Scout sat between digits, counting tabs gave the wrong chord for every
// tab after Insights. The palette's group labels carry the thematic
// adjacency instead. Skills and Context reach the screen through ⌘⇧S / ⌘⇧C
// and the ⌘K palette without changing the long-standing ⌘1–9 map or turning
// the rail into a ticker — and the palette button says which of them is on
// screen, so an off-rail view is never a surface with no visible route back.
//
// Every destination is on the sidebar. The horizontal rail carried thirteen of
// fifteen and left Skills and Context reachable only through ⌘K — a split that
// was never a judgement about those two views, only about how many text tabs
// fit across 960px. A vertical list has no such ceiling, so the compromise is
// retired and the palette goes back to being a search box rather than the sole
// route to two screens.
//
// This flattened order is what Up/Down walks, so it must match what the eye
// reads down the column: SIDEBAR_GROUPS is the single record of both.
const NAV_RAIL_TABS: readonly Tab[] = SIDEBAR_GROUPS.flatMap((section) => section.tabs);

/** A Goal is a durable Control record. Honour its deep link before the first
 * render so opening a copied Goal URL cannot strand someone on Sessions with
 * a perfectly valid `#goal=` fragment that nothing visible is reading. */
function initialTabFromLocation(): Tab {
  try {
    const goal = new URLSearchParams(window.location.hash.slice(1)).get('goal');
    return goal ? 'control' : 'mission';
  } catch {
    return 'sessions';
  }
}

/** The kinds that mean a human is the blocker, worst first. */
const NEEDS_YOU: AttentionKind[] = ['permission', 'error', 'finished'];

/**
 * One glyph per attention kind — the same shapes AttentionQueue's SPEC draws,
 * so a session reads the same in the strip, the rail popover and the palette.
 * The word beside it always comes from main (`Attention.label`), never from
 * here. AttentionQueue does not export SPEC yet; once it does, import it and
 * delete this table so the vocabulary has one home.
 */
const ATTENTION_GLYPH: Record<AttentionKind, string> = {
  permission: '?', error: '✕', finished: '✓', idle: '◦', working: '▸',
};

/** Glyph and word first, colour last — a nav dot that is only red is invisible
 *  to the people who most need to see it. */
const NEED_MARK: Record<string, { glyph: string; tone: string; phrase: (n: number) => string }> = {
  permission: { glyph: ATTENTION_GLYPH.permission, tone: 'alert',   phrase: (n) => `${n} waiting on a permission prompt` },
  error:      { glyph: ATTENTION_GLYPH.error,      tone: 'serious', phrase: (n) => `${n} stopped on an error` },
  finished:   { glyph: ATTENTION_GLYPH.finished,   tone: 'ok',      phrase: (n) => `${n} finished, waiting for review` },
};

/** The only parts of a session list the shell reacts to. */
const shape = (l: Session[]) => l.map((s) => `${s.id}:${s.status}:${s.projectId}`).join('|');
/** Likewise for the ranked attention list: identity, kind and when it began. */
const attentionShape = (l: Attention[]) => l.map((a) => `${a.sessionId}:${a.kind}:${a.since}:${a.transitionId}`).join('|');

/**
 * How many notification cards the window will stack before the oldest drops.
 *
 * Four, because that is about what fits above the status bar without becoming
 * the window. A fleet that raises five alerts in a minute is a fleet the
 * operator has to go and look at anyway, and a column that covers the view they
 * would look at is the fastest way to make somebody want the feature gone.
 */
const MAX_IN_APP_ALERTS = 4;

/**
 * How long a card stays before it fades on its own.
 *
 * Only the ones that are not urgent. A finished turn is news with a short shelf
 * life; a permission wait is a question that is still unanswered, and a
 * question that dismissed itself while the operator was in another window is
 * indistinguishable from never having been asked.
 */
const IN_APP_ALERT_MS = 12_000;

/**
 * How long the halt handle stays armed after the first click.
 *
 * Short. A click now and a stray click four minutes later must never be read as
 * one decision to kill every agent in the app — which is the failure mode a
 * two-step confirm has if the first step never expires.
 */
const HALT_ARM_MS = 6_000;

type InAppAlertCard = InAppAlert & { id: string };
/** Likewise for the shared project list: identity, name, path and branch. */
const projectShape = (l: Project[]) => l.map((p) => `${p.id}:${p.name}:${p.path}:${p.branch}`).join('|');

/**
 * The palette's Recent group: the last five keys run from it, per machine.
 * Keys only — no counts, no ranking — so localStorage is honest here, and a
 * key that no longer resolves (an exited session, a removed project) is just
 * not shown. Actions are excluded: they already sit at the top of the list.
 */
const RECENT_KEY = 'wanigan.palette.recent';
const RECENT_MAX = 5;
const RECENT_PREFIXES = ['view:', 'session:', 'project:', 'setting:'];
function readRecent(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string').slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
function rememberRecent(key: string): void {
  if (!RECENT_PREFIXES.some((prefix) => key.startsWith(prefix))) return;
  try {
    const next = [key, ...readRecent().filter((k) => k !== key)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* storage can be blocked */ }
}

type ViewTransitionDoc = Document & {
  startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> };
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
  // Whether a project-list read has actually returned. The list above seeds
  // empty and a failed read leaves it empty behind an error toast, so its
  // length cannot tell "you have no projects" from "nobody has looked yet" —
  // and Git told operators the first while the second was true. Passed to Git
  // rather than folded into `projects` as a nullable, because a dozen views
  // take that prop and only one of them can say anything useful about the
  // difference.
  const [projectsRead, setProjectsRead] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  // Runs still in flight, counted by main rather than derived here from 200
  // whole run rows. `null` means no read has returned yet, which is a different
  // claim from "nothing is in flight": the badge stays off the screen until a
  // read says so, and a failed refresh holds the last number that was actually
  // observed rather than printing a zero nobody measured.
  const [runsInFlight, setRunsInFlight] = useState<number | null>(null);
  // Requests returned out of requests submitted, across every run still in
  // flight. The nav bar advances on this and nothing else.
  const [batchWork, setBatchWork] = useState<{ done: number; total: number } | null>(null);
  const [needs, setNeeds] = useState<{ total: number; worst: AttentionKind | null; detail: string }>(
    { total: 0, worst: null, detail: '' });
  // The ranked attention list for live sessions, in main's order — worst kind
  // first, then longest wait. The counts above are derived from it; the rail
  // popover and the palette's session marks read it directly.
  const [attention, setAttention] = useState<Attention[]>([]);
  const [attentionRead, setAttentionRead] = useState<PresenceRead>('loading');
  // Cards raised by main, newest first. Deliberately not derived from the
  // attention list above: that list is a poll of what is true now, and a card
  // is a record that a transition happened — a prompt answered thirty seconds
  // after it appeared has left the list and still deserves to have been seen.
  const [alerts, setAlerts] = useState<InAppAlertCard[]>([]);
  // Polled, not derived from this window's own actions: the handle can be
  // pulled from a paired phone, and a window that only learned about a halt
  // when it caused one would go on drawing a fleet that is no longer running.
  const [halt, setHalt] = useState<HaltState | null>(null);
  // The "n need you" popover: the mark button it is anchored to, or null.
  const [needAnchor, setNeedAnchor] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<ShellError | null>(null);
  const [retryingError, setRetryingError] = useState(false);
  const [startup, setStartup] = useState<StartupStatus | null>(null);
  const [retryingStartup, setRetryingStartup] = useState(false);
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  // FTS answers for the current palette query — asked only while the palette
  // is open, debounced, and cleared with it. The archive is local; still,
  // nothing is searched until at least three characters ask for it.
  const [paletteHits, setPaletteHits] = useState<TranscriptHit[]>([]);
  const [paletteRead, setPaletteRead] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [settingsJump, setSettingsJump] = useState<SettingsJump | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  // The palette is a real modal. Remember where it came from so Escape and a
  // backdrop click put a keyboard user straight back where they started.
  const paletteOpenerRef = useRef<HTMLElement | null>(null);
  // The banner labels this window's fixed source. Switching mode creates a
  // new window with separate storage and reads its source again on mount.
  const [demoOn, setDemoOn] = useState(false);
  const [demoPrompt, setDemoPrompt] = useState<{ next: boolean } | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  // Which rail button holds the toolbar's single tab stop. Arrow keys move it
  // without switching view, so it can differ from the view on screen.
  const [navFocus, setNavFocus] = useState<Tab | null>(null);
  // Starts open. The stored answer arrives a frame later; rendering closed
  // until then would flash the shell narrow for everyone who never hid it.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // A request is deliberately one-shot. The Sessions view consumes it after
  // it mounts, so a later visit to Sessions never reopens an old dialog.
  const [newSessionRequest, setNewSessionRequest] = useState<number | null>(null);
  // A session handing its changed files to a new batch run.
  const [batchSeed, setBatchSeed] = useState<{ projectId: string; root: string; paths: string[] } | null>(null);
  // Which session the keyboard-less surfaces should talk to.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // The project the user last chose or last worked in, remembered per machine.
  const [picked, setPicked] = useState<string | null>(() => localStorage.getItem('wanigan.project'));
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const theme = useThemePreference();
  // Destructured so the palette corpus can depend on the three fields rather
  // than on an object whose identity changes every render.
  const { preference: themePreference, resolved: themeResolved, setTheme } = theme;

  const tabRef = useRef<Tab>(tab); tabRef.current = tab;
  const sessionsRef = useRef<Session[]>(sessions); sessionsRef.current = sessions;
  const tickRequest = useRef(0);

  const running = useMemo(() => sessions.filter((s) => s.status === 'running').length, [sessions]);
  const presence = useMemo(() => companionPresence(sessions, attention, attentionRead), [sessions, attention, attentionRead]);

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
    setProviders(pv); setProjects(pj); setHasKey(ks.present); setProjectsRead(true);
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

  // ── sidebar ────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try { setSidebarOpen((await window.wanigan.prefs.all()).navSidebar === 'open'); }
      catch { /* db not ready; the default stands */ }
    })();
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      const next = !open;
      void window.wanigan.prefs.set('nav_sidebar', next ? 'open' : 'closed').catch(() => {});
      return next;
    });
  }, []);

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
  // visible from whichever view you happen to be in. A failing endpoint moves
  // its own badge and no other; the batch badge additionally holds its last
  // observed value rather than reporting a zero it never read.
  const tick = useCallback(async () => {
    const request = ++tickRequest.current;
    const [ss, flight, att] = await Promise.all([
      window.wanigan.sessions.list().catch(() => null),
      // null, not an empty read: a badge is a claim about what is running, and
      // a call that failed has observed nothing to claim it from.
      window.wanigan.batch.runsInFlight().catch(() => null),
      window.wanigan.attention.list().catch(() => null),
    ]);
    if (request !== tickRequest.current) return;
    // Poll results are only allowed to re-render the app when they actually
    // differ — a new array every six seconds would re-render the view holding
    // the terminals for nothing.
    if (ss) setSessions((prev) => (shape(prev) === shape(ss) ? prev : ss));
    setAttentionRead(ss && att ? 'ready' : 'unavailable');

    // A failed read updates neither the badge nor the bar. Both are statements
    // about right now, and the last thing seen is closer to true than a zero.
    if (flight) {
      setRunsInFlight((prev) => (prev === flight.runs ? prev : flight.runs));
      const returned = flight.requestsReturned;
      const submitted = returned + flight.requestsOutstanding;
      // Nothing to show until the API has actually accepted rows; a bar at zero
      // width for a run that has not been submitted yet would be a guess.
      setBatchWork((prev) => {
        if (submitted <= 0) return prev === null ? prev : null;
        if (prev && prev.done === returned && prev.total === submitted) return prev;
        return { done: returned, total: submitted };
      });
    }

    if (!ss || !att) return;
    const live = new Set(ss.map((s) => s.id));
    const liveAttention = att.filter((a) => live.has(a.sessionId));
    setAttention((prev) => (attentionShape(prev) === attentionShape(liveAttention) ? prev : liveAttention));
    const byKind = new Map<AttentionKind, number>();
    for (const a of liveAttention) {
      if (!NEEDS_YOU.includes(a.kind)) continue;
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
    let eventRefresh: ReturnType<typeof setTimeout> | undefined;
    const offEvent = window.wanigan.on.sessionEvent(() => {
      if (eventRefresh || document.hidden) return;
      eventRefresh = setTimeout(() => { eventRefresh = undefined; void tick(); }, 250);
    });
    const t = setInterval(() => { if (document.hidden) return; void tick(); }, 6000);
    const offBatch = window.wanigan.on.batchChanged(() => void tick());
    const offList = window.wanigan.on.sessions((list) => {
      setSessions((prev) => (shape(prev) === shape(list) ? prev : list));
      void tick();
    });
    return () => { clearInterval(t); clearTimeout(eventRefresh); offEvent(); offBatch(); offList(); };
  }, [tick]);

  // Branches move constantly; keep the shared project list honest. Handing
  // `setProjects` the refresh result directly installed a new array identity
  // every thirty seconds whether or not a branch had actually moved, and
  // `projects` is a prop of a dozen views — so compare first, the way the
  // session and attention polls above already do.
  const refreshProjects = useCallback(() => {
    window.wanigan.projects.refresh()
      .then((list) => {
        setProjectsRead(true);
        setProjects((prev) => (projectShape(prev) === projectShape(list) ? prev : list));
      })
      .catch(() => {});
  }, []);

  // Both shell polls stop while the window is hidden. Chromium already
  // throttles a hidden renderer's timers toward roughly once a minute, but only
  // after about five minutes of hiding; the guard is what makes the first five
  // minutes free too, and it costs nothing because the catch-up effect below
  // re-reads the moment the window comes back.
  useEffect(() => {
    const t = setInterval(() => { if (document.hidden) return; refreshProjects(); }, 30_000);
    return () => clearInterval(t);
  }, [refreshProjects]);

  // One listener for both guarded polls: returning to a window that fell behind
  // should show current badge counts and current branches at once, not after
  // the next six- or thirty-second beat.
  useEffect(() => {
    const onVisible = () => { if (document.hidden) return; void tick(); refreshProjects(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [tick, refreshProjects]);

  // A project added from another surface (or over IPC) must not stay invisible
  // to Context/Learning until the 30s branch tick: refresh on window focus and
  // whenever one of the project-reading views comes on screen.
  useEffect(() => {
    const onFocus = () => { void loadShell().catch(() => {}); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadShell]);
  useEffect(() => {
    if (tab === 'context' || tab === 'learning' || tab === 'scout') void loadShell().catch(() => {});
  }, [tab, loadShell]);

  // ── the shared selection ───────────────────────────────────────────
  // If the session we were pointing at is gone, fall back to the newest live
  // one rather than handing a dead id to a session-aware surface.
  useEffect(() => {
    setActiveSessionId((cur) => {
      const scoped = spaceId ? sessions.filter((s) => s.projectId === spaceId) : sessions;
      if (cur && scoped.some((s) => s.id === cur)) return cur;
      const up = scoped.filter((s) => s.status === 'running');
      return (up[up.length - 1] ?? scoped[scoped.length - 1])?.id ?? null;
    });
  }, [sessions, spaceId]);

  const choose = useCallback((id: string) => {
    setSpaceId(id);
    setPicked(id);
    localStorage.setItem('wanigan.project', id);
  }, []);

  useEffect(() => {
    if (projectsRead && spaceId && !projects.some((p) => p.id === spaceId)) setSpaceId(null);
  }, [projects, projectsRead, spaceId]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null, [sessions, activeSessionId]);

  const orbStory=useContextStory(activeSession?.id??null,activeSession?.displayTitle||activeSession?.id||'');

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
  const projectName = useMemo(
    () => projects.find((p) => p.id === projectId)?.name ?? null, [projects, projectId]);

  // Electron takes the window title from document.title. hiddenInset hides the
  // bar itself, but Mission Control and the Window menu read it, and "Wanigan"
  // for every state named nothing.
  useEffect(() => {
    const label = labelForTab(tab);
    document.title = projectName ? `${label} — ${projectName}` : label;
  }, [tab, projectName]);

  // announce({ tone: 'error' }) lands in the shell toast, which keeps its
  // contract: message, runnable retry, Open <view>, Dismiss, Esc.
  const announceError = useCallback((text: string, action?: AnnounceAction) => {
    setError({ message: text, retry: action });
  }, []);

  // The popover lists the blocked sessions; when none remain its anchor is
  // gone too, so it closes rather than hanging off a mark that unmounted.
  useEffect(() => { if (needs.total === 0) setNeedAnchor(null); }, [needs.total]);

  // ── view switching ─────────────────────────────────────────────────
  const go = useCallback((next: Tab) => {
    if (next === tabRef.current) return;
    if (!['mission', 'sessions', 'board', 'git', 'context'].includes(next)) setSpaceId(null);
    else if (['git', 'context'].includes(next) && !spaceId && projectId) setSpaceId(projectId);
    const swap = () => setTab(next);
    const doc = document as ViewTransitionDoc;
    // A live PTY on either side of the swap means no transition at all.
    const touchesPty =
      (next === 'sessions' || tabRef.current === 'sessions') && sessionsRef.current.length > 0;
    if (touchesPty || !motionOn() || typeof doc.startViewTransition !== 'function') { swap(); return; }
    const transition = doc.startViewTransition(() => { flushSync(swap); });
    // A second navigation can skip the animation while the DOM update still
    // succeeds. Only finished rejects when the update itself fails.
    void transition.ready.catch(() => {});
    void transition.finished.catch((cause: unknown) => {
      announceError(`Could not open this view: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }, [spaceId, projectId, announceError]);

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
    setPaletteHits([]);
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
  const openGoal = useCallback((id: string, taskId?: string) => {
    window.history.replaceState(null, '', goalLocation(id, taskId));
    go('control');
  }, [go]);

  const focusSession = useCallback((id: string, projectId?: string) => {
    setActiveSessionId(id);
    const project = projectId ?? sessionsRef.current.find((x) => x.id === id)?.projectId;
    if (project) {
      setPicked(project); localStorage.setItem('wanigan.project', project);
      if (spaceId !== null) setSpaceId(project);
    }
  }, [spaceId]);

  // ⌘1–9. Capture phase, so the shell wins over any view handler underneath
  // (Sessions once bound the same digits to its tabs and only one of us could
  // win); inside a terminal neither of us takes the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.length !== 1) return;
      if (modalOpen()) return;  // a dialog owns the keyboard
      // New work should be available from every surface, not only after a
      // detour back to Sessions. The terminal still owns this shortcut while
      // it has focus, just as it owns the number keys below: bindingMatches
      // refuses every chord but ⌘. inside a terminal host.
      if (bindingMatches(e, 'new-session')) {
        e.preventDefault();
        e.stopPropagation();
        requestNewSession();
        return;
      }
      // Runs is the tenth surface. It deserves a direct route rather than
      // being the only tab that disappears once the header overflows.
      if (bindingMatches(e, 'view:runs')) {
        e.preventDefault();
        e.stopPropagation();
        go('runs');
        return;
      }
      // The key every Mac user already tries for preferences. Settings sits
      // past the digit row, so without this it had no direct route at all.
      if (bindingMatches(e, 'view:settings')) {
        e.preventDefault();
        e.stopPropagation();
        go('settings');
        return;
      }
      // Positional: ⌘n is the nth entry of TABS, which is why routes.ts keeps
      // the surfaces past the digit row at the end of that list.
      if (inTerminal()) return;                            // the PTY owns its keystrokes
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > DIGIT_ROUTES) return;
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
      if (!bindingMatches(e, 'palette')) return;
      // ⌘K closes the palette it opened; any other open dialog keeps the key.
      if (!palette && modalOpen()) return;
      e.preventDefault();
      if (palette) closePalette();
      else openPalette();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [closePalette, openPalette, palette]);

  // The sheet answers "what can I press" — `?` where typing it is free, ⌘/
  // where a field would swallow the bare key. Never inside the terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // One binding, two alternatives: the table refuses the bare `?` inside a
      // field and every chord inside a terminal.
      if (!bindingMatches(e, 'sheet')) return;
      if (!shortcuts && modalOpen()) return;
      e.preventDefault();
      setShortcuts((open) => !open);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shortcuts]);

  // Split from addProject so the failure can hand the toast the same work to
  // run again; a callback that reported its own failure could not be its retry.
  const pickProject = useCallback(async () => {
    const p = await window.wanigan.projects.pick();
    if (p) {
      const list = await window.wanigan.projects.list();
      setProjectsRead(true); setProjects(list); choose(p.id);
    }
  }, [choose]);

  const addProject = useCallback(async () => {
    try { await pickProject(); }
    catch (e) { reportError(e, { label: 'Choose a folder again', run: pickProject }); }
  }, [pickProject, reportError]);

  const removeProject = useCallback(async (id: string) => {
    const list = await window.wanigan.projects.remove(id);
    setProjectsRead(true); setProjects(list);
  }, []);

  // ── nav chrome ─────────────────────────────────────────────────────
  const tabsRef = useRef<HTMLDivElement>(null);
  const runBadge = useRef<HTMLSpanElement>(null);
  const needBadge = useRef<HTMLButtonElement>(null);
  const lastNeeds = useRef(0);

  // The list behaves like a vertical toolbar. Tab enters it once, and Up/Down
  // (or Home/End) walks every route without asking a keyboard user to tab
  // through fifteen small controls. Left/Right are deliberately unbound: the
  // axis the arrows move on should match the axis the list is drawn on.
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
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % NAV_RAIL_TABS.length;
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + NAV_RAIL_TABS.length) % NAV_RAIL_TABS.length;
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

  // A sliding underline was the rail's way of saying which of thirteen
  // same-looking tabs was live. A sidebar row can simply be filled, so the
  // measured-geometry ink is gone and only the part that was doing real work
  // survives: keeping the current destination inside the scroll box when it was
  // reached by a chord or the palette rather than by clicking it.
  useEffect(() => {
    const on = tabsRef.current?.querySelector<HTMLElement>('.nav-tab.on');
    on?.scrollIntoView({ block: 'nearest' });
  }, [tab]);

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

  // Each mode owns a separate browser storage partition and main-process
  // data source. Read only the source label; no personal mapping reaches UI.
  useEffect(() => {
    let mounted = true;
    const read = () => window.wanigan.demo.state().then((s) => {
      if (mounted) setDemoOn(s.on);
    });
    void read().catch(e => { if (mounted) reportError(e, { label: 'Read demo state', run: read }, 'settings'); });
    return () => { mounted = false; };
  }, [reportError]);

  const applyDemo = useCallback((next: boolean) => {
    setDemoBusy(true);
    void window.wanigan.demo.set(next)
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
      if (modalOpen()) return;  // a dialog owns the keyboard
      // bindingMatches refuses every one of these inside a terminal host: the
      // PTY owns its keystrokes.
      if (bindingMatches(e, 'demo')) {
        e.preventDefault();
        e.stopPropagation();
        setDemoPrompt({ next: !demoOn });
        return;
      }
      // The named chords for the surfaces past the digit row, matched against
      // the same aria-keyshortcuts strings the rail publishes for them.
      const chord = TABS.find((item) => bindingMatches(e, `view:${item.id}`));
      if (!chord) return;
      e.preventDefault();
      e.stopPropagation();
      go(chord.id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [demoOn, go]);

  // ── terminal output ────────────────────────────────────────────────
  // For the window's lifetime, not the Sessions view's. Views mount and unmount
  // as tabs change; a live agent does not stop printing because you stepped
  // over to Git. See startTerminalOutputPump for what the old placement cost.
  useEffect(() => startTerminalOutputPump(), []);

  // ── the macOS menu bar, and the notification banner ────────────────
  // Both are main-process surfaces that name a destination and leave the
  // navigating to this window. The menu was built from shared/routes.ts, so
  // "Go › Fleet" and ⌘2 and the sidebar row are one route reached three ways.
  useEffect(() => {
    const off = window.wanigan.on.menuRoute((route) => {
      switch (route.kind) {
        case 'tab': go(route.tab); break;
        case 'new-session': requestNewSession(); break;
        // A menu item that opens a dialog must not hand focus back to a menu
        // that has already closed, which is what the palette's opener
        // restoration would otherwise try to do.
        case 'palette': paletteOpenerRef.current = null; setPaletteQuery(''); setPalette(true); break;
        case 'shortcuts': setShortcuts(true); break;
        case 'sidebar': toggleSidebar(); break;
      }
    });
    return () => { off(); };
  }, [go, requestNewSession, toggleSidebar]);

  // A clicked notification. Main raises the window and says which session or
  // run the banner was about; until now nothing in the renderer listened, so
  // the operator was told an agent needed them and then landed on whatever tab
  // happened to be open, with the name of the agent only in the banner they
  // had just dismissed.
  useEffect(() => {
    const off = window.wanigan.on.notificationOpened((route) => {
      if (route.kind === 'session') { focusSession(route.sessionId); go('sessions'); }
      else go('runs');
    });
    return () => { off(); };
  }, [focusSession, go]);

  useEffect(() => {
    // Compared before it is stored. The IPC boundary hands back a fresh object
    // every time, so assigning it unconditionally re-rendered the entire shell
    // every five seconds forever — which is both wasted work and, until the
    // card sweep above was rewritten, the thing that stopped notifications from
    // ever dismissing themselves.
    const read = () => {
      window.wanigan.halt.state()
        .then((next) => setHalt((prev) => (
          prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next
        )))
        .catch(() => {});
    };
    read();
    // Guarded like every other poll in the app: a hidden window is not one
    // anybody is reading a halt banner in, and this is the only interval that
    // was still asking every five seconds behind a closed lid. Read once on the
    // way back so becoming visible never shows a stale one.
    const tick = () => { if (document.hidden) return; read(); };
    const timer = window.setInterval(tick, 5_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, []);

  // The same notification, inside the window. Main decides what is worth one —
  // permission waits, errors and finished turns, and nothing else — so this
  // holds no policy of its own, only the last few and how long they stay.
  useEffect(() => {
    const off = window.wanigan.on.notificationRaised((alert) => {
      setAlerts((prev) => {
        // Newest first, and keyed by arrival time. A burst of three finished
        // turns is three cards; a stack that replaced them with a count would
        // hide which agents they were, which is the whole content of the alert.
        const next = [{ ...alert, id: `${alert.at}:${prev.length}:${alert.title}` }, ...prev];
        return next.slice(0, MAX_IN_APP_ALERTS);
      });
    });
    return () => { off(); };
  }, []);

  // ⌥⌘S: the destination list off and on. Its own handler because the two
  // above both refuse Option — the digit row takes ⌘ alone and the named
  // routes take ⌘⇧, and widening either guard would let a chord meant for one
  // of them fall through to the other.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen()) return;
      if (!bindingMatches(e, 'sidebar')) return;
      e.preventDefault();
      e.stopPropagation();
      toggleSidebar();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggleSidebar]);

  // Escape dismisses the shell error, matching every other overlay here. It
  // stays out of the way of a terminal and of anything more modal than itself.
  useEffect(() => {
    if (!error) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (inTerminal() || modalOpen()) return;
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
  const jumpToSettings = useCallback((jump: Omit<SettingsJump, 'nonce'>) => {
    setSettingsJump({ ...jump, nonce: Date.now() });
    go('settings');
  }, [go]);

  useEffect(() => {
    if (!palette) return;
    const q = paletteQuery.trim();
    setPaletteHits([]);
    if (q.length < TRANSCRIPT_QUERY_MIN) { setPaletteRead('idle'); return; }
    setPaletteRead('loading');
    let cancelled = false;
    const timer = window.setTimeout(() => {
      window.wanigan.transcripts.search(q, TRANSCRIPT_RESULT_CAP)
        .then((hits) => { if (!cancelled) { setPaletteHits(hits); setPaletteRead('ready'); } })
        .catch(() => { if (!cancelled) { setPaletteHits([]); setPaletteRead('error'); } });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [palette, paletteQuery]);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [{
      key: 'action:new-session',
      title: 'New session',
      hint: 'Start an interactive agent',
      meta: '⌘T',
      primary: true,
      group: 'Actions',
      haystack: 'new session start agent interactive terminal',
      run: requestNewSession,
    }, {
      key: 'action:shortcuts',
      title: 'Keyboard shortcuts',
      hint: 'Every binding, grouped by where it works',
      meta: '?',
      group: 'Actions',
      haystack: 'keyboard shortcuts keys cheat sheet bindings help',
      run: () => setShortcuts(true),
    }];
    // Appearance left the title bar. Three rows keep it two keystrokes away;
    // the native select itself lives in Settings › App.
    const appearances: Array<{ value: ThemeSetting; word: string }> = [
      { value: 'system', word: 'System' }, { value: 'light', word: 'Light' }, { value: 'dark', word: 'Dark' },
    ];
    for (const { value, word } of appearances) {
      const apply = () => setTheme(value);
      items.push({
        key: `action:appearance:${value}`,
        title: `Appearance: ${word}`,
        hint: value === 'system' ? `Follow the Mac's appearance (${themeResolved} right now)` : `Use the ${word.toLowerCase()} theme everywhere`,
        meta: 'Setting',
        group: 'Actions',
        staysPut: true,
        mark: themePreference === value ? { glyph: '●', word: 'current' } : undefined,
        haystack: `appearance theme ${value} light dark system colour color`,
        run: () => {
          void apply().catch((e) => reportError(e, { label: `Set appearance to ${word}`, run: apply }, 'settings'));
        },
      });
    }
    for (const item of TABS) {
      items.push({
        key: `view:${item.id}`,
        title: item.label,
        hint: `${item.group} · ${item.hint}`,
        meta: TAB_SHORTCUTS[item.id].label,
        group: 'Views',
        haystack: `${item.label} ${item.group} ${item.keywords}`,
        run: () => go(item.id),
      });
    }
    const attentionBySession = new Map(attention.map((a) => [a.sessionId, a] as const));
    for (const s of sessions) {
      if (s.status === 'exited') continue;
      // The session's state as glyph and word — the vocabulary the attention
      // strip already renders — rather than a status printed as plain text.
      const a = attentionBySession.get(s.id);
      items.push({
        key: `session:${s.id}`,
        title: s.title || s.projectName,
        hint: `${s.status} · ${s.projectName}${s.model ? ` · ${s.model}` : ''}`,
        mark: a ? { glyph: ATTENTION_GLYPH[a.kind], word: a.label } : undefined,
        meta: 'Session',
        group: 'Live sessions',
        haystack: `${s.title} ${s.projectName} ${s.providerId} ${s.model ?? ''} session agent`,
        run: () => openSession(s.id),
      });
    }
    for (const p of projects) {
      const active = p.id === projectId;
      items.push({
        key: `project:${p.id}`,
        title: p.name,
        // Says exactly what pressing it does. Choosing a project moves no view,
        // so a row promising to "open" one would be describing something else.
        // The header carries no project indicator by design; this row is
        // where the shell confirms which project it is pointed at.
        hint: `${active ? 'Already active' : 'Make active'} for Learning, Context and Skills${p.branch ? ` · ${p.branch}` : ''}`,
        mark: active ? { glyph: '●', word: 'active' } : undefined,
        meta: 'Project',
        group: 'Projects',
        staysPut: true,
        haystack: `${p.name} ${p.path} ${p.branch ?? ''} project repository folder`,
        run: () => choose(p.id),
      });
    }
    for (const entry of SETTINGS_INDEX) {
      items.push({
        key: `setting:${entry.tab}:${entry.section}`,
        title: entry.section,
        hint: `Settings › ${entry.tabLabel} — ${entry.hint}`,
        meta: 'Setting',
        group: 'Settings',
        haystack: `${entry.section} ${entry.keywords} settings ${entry.tabLabel}`,
        run: () => jumpToSettings({ tab: entry.tab, section: entry.section }),
      });
    }
    // Already matched by the archive's FTS index; the palette must not
    // re-judge them with a substring rule that tokenises differently.
    paletteHits.forEach((hit, index) => {
      items.push({
        ...transcriptHitRow(hit, index),
        group: 'Transcripts',
        run: () => jumpToSettings({
          tab: 'privacy', section: 'Search transcripts',
          transcriptQuery: paletteQuery.trim(), openSessionId: hit.sessionId,
        }),
      });
    });
    return items;
  }, [attention, choose, go, jumpToSettings, openSession, paletteHits, paletteQuery, projectId, projects,
    reportError, requestNewSession, sessions, setTheme, themePreference, themeResolved]);

  return (
    <>
    {/* The providers wrap the shell's content at the shell's own indentation:
        announce() and per-view memory are reachable from every view, and the
        polite region they feed is rendered inside the shell below the toast. */}
    <div className="shell mission-shell">
    <AnnounceProvider onError={announceError}>
    <ViewMemoryProvider>
      {startup?.phase === 'recovery' && (
        <section className="startup-recovery" role="alert">
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
      {/* Sample activity must remain labelled across destinations. */}
      {demoOn && (
        <section className="startup-recovery demo-banner" role="status">
          <div>
            <strong>Demo workspace · Fictional data</strong>
            <span>
              Projects, sessions, transcripts and usage figures are examples. Real work stays private; demo actions cannot change it.
            </span>
            <small>Turn it off here, in Settings › App, or with ⌘⇧D.</small>
          </div>
          <button className="btn" type="button" onClick={() => setDemoPrompt({ next: false })}>
            Turn off demo mode
          </button>
        </section>
      )}
      {/* One row, not two. The title bar and the tab strip were 52px + 48px of
          permanent chrome above every view; the destinations moved to the side,
          so the second row is gone and the terminal is 48px taller. The row
          keeps its left inset for the traffic lights. */}
      <header className="app-header">
          <button className="hdr-toggle" type="button" onClick={toggleSidebar}
                  aria-expanded={sidebarOpen} aria-controls="wanigan-sidebar"
                  aria-keyshortcuts="Alt+Meta+S"
                  title={`${sidebarOpen ? 'Hide' : 'Show'} the destination list (⌥⌘S)`}
                  aria-label={`${sidebarOpen ? 'Hide' : 'Show'} the destination list (Option Command S)`}>
            <Icon name="panel" />
          </button>
          <div className="brand-lockup">
            <span className="brand">Wanigan</span>
            {/* The view on screen, not a tagline. A sidebar row is filled to
                show where you are, but the row can be hidden and the window can
                be behind another; the header should still answer "what am I
                looking at" without a second glance. */}
            <span className="brand-context" aria-hidden="true">{labelForTab(tab)}</span>
          </div>

        <ProjectSpaces projects={projects} selected={spaceId} ready={projectsRead} onAdd={addProject}
            onSelect={(id) => { setSpaceId(id); if (id) choose(id);
              if (!['mission', 'sessions', 'board', 'git', 'context'].includes(tab) || (!id && ['git', 'context'].includes(tab))) go('mission'); }} />
          <div className="nav-actions">
            {/* The Learning view owns its scope control now — a nav-level
                project select that only sometimes rendered was the invisible
                scope that let two surfaces state contradictory counts. */}

            {/* The emergency stop lives in the header rather than on a page,
                because the moment you want it you do not want to navigate
                first. It is a small, quiet control until it is pulled — an
                always-red button in permanent chrome is one you stop seeing. */}
            <HaltControl halt={halt} onChange={setHalt} />

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

                The "view on screen is not in the list" branch is now a
                fallback rather than a daily state: SIDEBAR_GROUPS carries all
                fifteen routes, so it fires only if a route is added to TABS
                and left out of a group. Keeping it means that mistake shows up
                as a named view in the header instead of a shell with nothing
                marked current anywhere. */}
            <div className="nav-views">
              <button className={`nav-views-button${railHasActiveTab ? '' : ' on'}`} type="button"
                      aria-haspopup="dialog" aria-expanded={palette}
                      aria-current={railHasActiveTab ? undefined : 'page'}
                      aria-keyshortcuts="Meta+K Control+K"
                      title={railHasActiveTab
                        ? 'Search views, projects, live sessions, settings and transcripts (⌘K)'
                        : `${labelForTab(tab)} is the view on screen — search every view, project and live session (⌘K)`}
                      aria-label={railHasActiveTab
                        ? 'Search views, projects, live sessions, settings and transcripts (Command K)'
                        : `${labelForTab(tab)} is the view on screen. Search every view, project and live session (Command K)`}
                      onClick={() => (palette ? closePalette() : openPalette())}>
                {railHasActiveTab
                  ? <span>Search</span>
                  : <span><span aria-hidden="true">✓ </span>{labelForTab(tab)}</span>}
                <span className="nav-views-shortcut" aria-hidden="true">⌘K</span>
              </button>
            </div>

            {/* Two controls and one status, not four. The "+ Headless runs ⌘0"
                button navigated to the Runs tab 48px below it and created
                nothing; Runs, ⌘0 and the palette remain its routes. The Theme
                select left the title row for Settings › App, where the same
                native control already lives, and the palette gained three
                "Appearance: …" actions so the change stays two keystrokes
                away — the setting is not hidden, it is no longer the widest
                thing in the toolbar. */}
            {activeSession && <ProviderUsageBadge session={activeSession} providers={providers} />}
          </div>
      </header>

      {/* Destinations left the horizontal axis. Thirteen text tabs needed a
          second 48px header row and still overflowed at 960px with Runs and
          Settings off-screen behind a 5px scrollbar — the rail's own rationale
          (index.css) failed at the width it was written for. A vertical list
          holds all fifteen with room for an icon, the marks and the chord, and
          the window gets those 48px back for the terminal. ⌘1–9, ⌘0, ⌘, and
          every ⌘⇧ chord are unchanged; the palette is still the complete
          index. */}
      {/* Above the workspace, not inside it. A halted fleet is a fact about the
          whole app rather than about whichever tab is on screen, so it belongs
          in the same band as the recovery strip and the demo banner — and it
          sits outside the view's error boundary, because a screen that crashed
          is one of the reasons somebody pulls the handle.

          Placed here specifically rather than one element lower: .workspace is
          a flex ROW holding the sidebar and the view, and a banner dropped into
          it becomes a third column that stretches to the full height of the
          window. */}
      {halt?.halted && <HaltBanner halt={halt} onChange={setHalt} />}
      <SpaceRoutes tab={tab} go={go} projectName={spaceId ? projectName : null} />
      <div className="workspace">
        {sidebarOpen && (
          <nav className="sidebar" id="wanigan-sidebar" aria-label="Primary navigation">
            <div className="sidebar-scroll" ref={tabsRef} role="toolbar" aria-label="Wanigan views" aria-orientation="vertical">
              {SIDEBAR_GROUPS.map((section) => (
                <div className="sidebar-group" key={section.group}>
                  <div className="sidebar-group-label">{section.group}</div>
                  {section.tabs.map((id) => (
                    <NavTab key={id} id={id} tab={tab} go={(next) => { go(next); setSidebarOpen(false); }} label={labelForTab(id)}
                            roving={navRoving} onKeyDown={onNavTabKeyDown}
                            badge={id === 'sessions' && running > 0 ? (
                              <span className="nav-badge mo-breathe" ref={runBadge}
                                    title={`${running} session${running === 1 ? '' : 's'} running`}>{running}</span>
                            ) : id === 'batches' && runsInFlight !== null && runsInFlight > 0 ? (
                              <span className="nav-badge"
                                    title={`${runsInFlight} run${runsInFlight === 1 ? '' : 's'} in flight — the same runs the Batches list counts as Active`}>{runsInFlight}</span>
                            ) : null}
                            progress={id === 'batches' && batchWork ? (
                              <span className="nav-progress" role="progressbar" aria-valuemin={0} aria-valuemax={batchWork.total}
                                    aria-valuenow={batchWork.done}
                                    title={`${num(batchWork.done)} of ${num(batchWork.total)} requests returned`}>
                                <span className="mo-fill"
                                      style={{ '--mo-p': batchWork.done / batchWork.total } as React.CSSProperties} />
                              </span>
                            ) : null}
                            marks={id === 'fleet' && mark ? (
                              // A door, not a badge. The per-kind sentence used to live in a
                              // hover title while the click landed on Fleet; now the mark opens
                              // the list of who is waiting, worst first, each row a jump to
                              // that session.
                              <button className={`nav-mark tone-${mark.tone}`} type="button" ref={needBadge}
                                      aria-haspopup="dialog" aria-expanded={needAnchor !== null}
                                      aria-label={`${needs.total} need you: ${needs.detail}. Show who is waiting.`}
                                      onClick={(e) => setNeedAnchor((cur) => (cur ? null : e.currentTarget))}>
                                <span aria-hidden="true">{mark.glyph}</span>
                                {needs.total} need you
                              </button>
                            ) : id === 'batches' && !hasKey ? (
                              // The API key gates batch submission and nothing else. On the
                              // Settings tab it was a permanent warning that read as "Wanigan
                              // is not set up", from every screen, while Sessions, Fleet,
                              // Control, Runs, Learning, Git and Schedules all work without
                              // one. It belongs on the surface it is actually true about.
                              // Quiet rather than amber for the same reason: a fresh install
                              // is not agent attention, and --warning stays reserved for that.
                              <button className="nav-mark tone-quiet" type="button"
                                      aria-label="Batch submission needs an API key. Open Settings › Agents › Claude Platform API key. Interactive sessions, Fleet, Control, Runs, Learning, Git and Schedules do not need it."
                                      onClick={() => jumpToSettings({ tab: 'agents', section: 'Claude Platform API key' })}>
                                <span aria-hidden="true">!</span>key
                              </button>
                            ) : null} />
                  ))}
                </div>
              ))}
            </div>
          </nav>
        )}

      {/* The boundary sits here and not around the shell: a view that cannot
          render must not take the header, the rail or ⌘K with it. `view={tab}`
          means leaving a broken surface clears the fallback by itself. */}
      <div className="body">
        <ErrorBoundary view={tab} label={labelForTab(tab)}>
          {/* Inside the boundary on purpose: the fallback unmounts this scope
              without mounting another, which is how a broken view's memory is
              marked for clearing before the next mount. */}
          <ViewMemoryScope view={tab}>
          {demoOn && !(DEMO_VIEWS as readonly string[]).includes(tab) ? (
            <main className="pane">
              <PageHead title={labelForTab(tab)} eyebrow="Demo workspace" />
              <EmptyState posture="nothing-yet" title="This demo surface is still being prepared."
                cue="Explore Mission, Sessions, Fleet and Usage with fictional data. Your real records stay private." />
            </main>
          ) : <>
          {tab === 'mission' && <MissionRoom story={orbStory} followedSession={activeSessionId} sessions={sessions} onFollow={setActiveSessionId} demo={demoOn} projectId={spaceId} presence={presence} onOpenSession={openSession}
            onProject={(id) => { choose(id); go('sessions'); }} onAddProject={addProject}
            onNewSession={requestNewSession} onSettings={() => jumpToSettings({ tab: 'agents', section: 'Claude Platform API key' })}
            onUsage={() => go('usage')} />}
          {tab === 'sessions' && (
            <Sessions providers={providers} projects={projects} selectedProjectId={spaceId}
                      onAddProject={addProject} onError={reportSessionError} onOpenGoal={openGoal}
                      activeId={activeSessionId} onActiveChange={focusSession}
                      newSessionRequest={newSessionRequest} onNewSessionRequestConsumed={consumeNewSessionRequest}
                      onSendToBatch={(seed) => { setBatchSeed(seed); go('batches'); }} />
          )}
          {tab === 'fleet' && <Fleet projects={projects} onOpenSession={openSession} onNewSession={requestNewSession} />}
          {tab === 'board' && (
            <Board projects={projects} providers={providers} projectId={projectId} selectedProjectId={spaceId}
                   onPickProject={(id) => { setSpaceId(id); if (id) choose(id); }}
                   onOpenGoal={openGoal} onOpenSession={openSession} />
          )}
          {tab === 'control' && <Control projects={projects} providers={providers} onOpenSession={openSession} />}
          {/* Land on the key, not on Settings. The nav mark beside this tab
              already deep-links to the exact section; sending the operator to
              the top of a 5,000-line surface to find it themselves was the one
              door that did not. */}
          {tab === 'batches' && (
            <Batches projects={projects} hasKey={hasKey}
                     onNeedKey={() => jumpToSettings({ tab: 'agents', section: 'Claude Platform API key' })}
                     seed={batchSeed} onSeedConsumed={() => setBatchSeed(null)} />
          )}
          {tab === 'insights' && <InsightsView />}
          {tab === 'usage' && <UsageView />}
          {tab === 'learning' && (
            <Learning projectId={projectId} projects={projects} providers={providers}
                      onPickProject={choose} initialTarget={learningTarget} />
          )}
          {/* Scout talks to window.wanigan.scout and nothing else in this app
              does. Its props are unchanged from when it hung off Learning. */}
          {tab === 'scout' && <ImprovementScout projects={projects} onOpenGoal={openGoal} />}
          {tab === 'skills' && (
            <Skills projectId={projectId} providers={providers} activeSessionId={activeSessionId} />
          )}
          {tab === 'context' && (
            <Context projectId={projectId} projects={projects} projectsRead={projectsRead} onPickProject={choose}
                     onReloadProjects={loadShell} onOpenLearning={openLearning} />
          )}
          {tab === 'plugins' && <Plugins />}
          {tab === 'schedules' && <Schedules projects={projects} />}
          {tab === 'git' && <Git projects={projects} projectsRead={projectsRead} selectedProjectId={spaceId ?? projectId} onPickProject={choose} />}
          {tab === 'runs' && <HeadlessRuns projects={projects} providers={providers} />}
          {tab === 'settings' && (demoOn ? <main className="pane">
            <PageHead title="Settings" eyebrow="Demo workspace" lead="These appearance choices apply only to this demo." />
            <Segmented label="Demo theme" value={theme.preference} options={[{value:'dark',label:'Dark'},{value:'light',label:'Light'},{value:'system',label:'System'}]} onChange={theme.setTheme} />
            <DemoPanel />
          </main> : <SettingsView providers={providers} projects={projects} jump={settingsJump}
                          onKeyChange={loadShell} onRemoveProject={removeProject} onAddProject={addProject}
                          themePreference={theme.preference} resolvedTheme={theme.resolved} onThemeChange={theme.setTheme} />
          )}
          </>}
          </ViewMemoryScope>
        </ErrorBoundary>
      </div>
      </div>

      <SpaceDock tab={tab} go={go} needs={needs.total} expanded={sidebarOpen} onMore={toggleSidebar}
        companion={tab === 'mission' ? undefined : <CompanionPresence story={orbStory} presence={presence}
          expanded={!!needAnchor?.closest('.companion-presence')} onAttention={setNeedAnchor} onHome={() => go('mission')} />} />
      {/* role=alert is itself an assertive live region; declaring aria-live as
          well made some VoiceOver builds read the message twice. */}
      {error && (
        <div className="toast" role="alert">
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
      {alerts.length > 0 && (
        <AlertStack
          alerts={alerts}
          onOpen={(alert) => {
            setAlerts((prev) => prev.filter((row) => row.id !== alert.id));
            if (!alert.target) return;
            if (alert.target.kind === 'session') { focusSession(alert.target.sessionId); go('sessions'); }
            else go('runs');
          }}
          onDismiss={(id) => setAlerts((prev) => prev.filter((row) => row.id !== id))}
          onDismissAll={() => setAlerts([])}
        />
      )}
      {palette && (
        <CommandPalette
          query={paletteQuery}
          onQuery={setPaletteQuery}
          items={paletteItems}
          transcriptRead={paletteRead}
          onClose={closePalette}
          onRun={(item) => { closePalette(item.staysPut === true); item.run(); }}
        />
      )}
      {demoPrompt && (
        <DemoConfirm next={demoPrompt.next} busy={demoBusy}
                     onCancel={() => setDemoPrompt(null)}
                     onConfirm={() => applyDemo(demoPrompt.next)} />
      )}
      {shortcuts && <ShortcutSheet onClose={() => setShortcuts(false)} />}
      {needAnchor && (
        <NeedYouPopover anchor={needAnchor} attention={attention} sessions={sessions} read={attentionRead}
                        onOpen={(id) => { setNeedAnchor(null); openSession(id); }}
                        onClose={() => setNeedAnchor(null)} />
      )}
      <AnnounceRegion />
    </ViewMemoryProvider>
    </AnnounceProvider>
    </div>
    {/* Dialogs portal here, beside the shell rather than inside it. .body
        carries a view-transition-name, which makes it a stacking context, so
        a dialog rendered from inside a view painted under the header; a root
        outside .body puts every dialog above the chrome while leaving that
        motion rule exactly as its comment asks. Empty until something opens. */}
    <div id={OVERLAY_ROOT_ID} className="overlay-root" />
    </>
  );
}

/**
 * The blocked list behind "n need you": who is waiting, worst first, each row
 * a door to that session. Main ranks — worst kind, then longest wait — and this
 * list renders that order untouched, exactly as the attention strip does. For
 * the shell it is a dialog (⌘1–9 must not fire behind it) and, like every
 * overlay here, it does not animate: a live terminal may be on screen under it.
 */
function NeedYouPopover({ anchor, attention, sessions, read, onOpen, onClose }: {
  anchor: HTMLElement; attention: Attention[]; sessions: Session[]; read: PresenceRead;
  onOpen: (sessionId: string) => void; onClose: () => void;
}) {
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'first' });
  const rows = read === 'ready' ? [...new Map(attention.filter(a => NEEDS_YOU.includes(a.kind) && sessions.some(s => s.id === a.sessionId)).map(a => [a.sessionId, a])).values()] : [];
  // Anchored under the mark that opened it, from measured geometry; clamped
  // so the panel never runs off the right edge on a narrow window.
  const rect = anchor.getBoundingClientRect();
  const place = {
    '--pop-left': `${Math.max(8, Math.min(rect.left, window.innerWidth - 372))}px`,
    '--pop-top': rect.top > window.innerHeight / 2 ? 'auto' : `${Math.round(rect.bottom + 6)}px`,
    '--pop-bottom': rect.top > window.innerHeight / 2 ? `${Math.round(window.innerHeight - rect.top + 6)}px` : 'auto',
  } as React.CSSProperties;
  return portal(
    <div {...backdropProps} className="overlay-backdrop clear">
      <section {...dialogProps} className="need-popover" aria-label="Sessions that need you" style={place}>
        <h2>{read !== 'ready' ? 'Waiting for a fresh read.' : rows.length === 0 ? 'All caught up.' : 'A quick look together.'}</h2>
        <p className="need-intro">{read !== 'ready' ? 'Session attention is unavailable right now.' : rows.length === 0 ? 'Nothing is waiting on you now.' : `${rows.length} ${rows.length === 1 ? 'session needs' : 'sessions need'} you. Permissions first, then problems and finished turns.`}</p>
        <div className="need-rows">
          {rows.map((a) => {
            const tone = NEED_MARK[a.kind]?.tone ?? 'ok';
            const session = sessions.find((s) => s.id === a.sessionId);
            const project = session?.projectName ?? `session ${a.sessionId.slice(0, 6)}`;
            return (
              <button key={a.sessionId} className="need-row" type="button" onClick={() => onOpen(a.sessionId)}
                      aria-label={`${a.label}: ${project}, since ${ago(a.since)}.${a.detail ? ` ${a.detail}.` : ''} Open this session.`}>
                <span className={`nav-mark tone-${tone}`}>
                  <span aria-hidden="true">{ATTENTION_GLYPH[a.kind]}</span>{a.label}
                </span>
                <span className="need-row-project"><strong>{session?.displayTitle || session?.title || project}</strong><span>{project}{a.detail ? ` · ${a.detail}` : ''}</span><small>{a.kind === 'permission' ? 'Open the permission prompt' : a.kind === 'error' ? 'Inspect the session' : session?.status === 'exited' ? 'Read the ended session' : 'Read the finished turn'} <span aria-hidden="true">↗</span></small></span>
                <span className="need-row-wait">{ago(a.since)}</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>,
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
  // Least-destructive first: Enter on an unread dialog must not rewrite every
  // name on screen and reload the window, so Cancel takes the initial focus and
  // Confirm is one Tab away. While the reload is in flight nothing closes it.
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({
    onClose: () => { if (!busy) onCancel(); },
    initialFocus: 'least-destructive',
  });
  return portal(
    <div {...backdropProps}>
    <section {...dialogProps} className="modal" aria-labelledby="wanigan-demo-title">
      <h2 id="wanigan-demo-title" style={{ fontSize: 'var(--t-title)', fontWeight: 600 }}>
        {next ? 'Turn on demo mode?' : 'Turn off demo mode?'}
      </h2>
      <p className="dim" style={{ marginTop: 8, lineHeight: 1.55 }}>
        {next
          ? 'Open a separate workspace with fictional projects, sessions, terminal text and usage figures. Demo actions cannot access your files, accounts, agents or saved drafts.'
          : 'Return to your real workspace. Your projects, drafts, accounts and terminal output will be visible again.'}
      </p>
      <p className="faint" style={{ marginTop: 8, lineHeight: 1.5 }}>
        Switching replaces the window and keeps existing agent processes running in the background.
        Demo mode suppresses Wanigan’s desktop alerts. Quit still ends live sessions.
        A banner labels fictional data throughout the demo.
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button className="btn" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" type="button" onClick={onConfirm} disabled={busy}>
          {busy ? 'Applying…' : next ? 'Open demo workspace' : 'Return to real workspace'}
        </button>
      </div>
    </section>
    </div>,
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
  const [ctx, setCtx] = useState<{ key: string; value: ClaudeContextUsage } | null>(null);
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
  const usesClaudeContextMeter = context?.usesClaudeContextMeter ?? false;
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
    // The context meter rides beside the session telemetry, never instead of
    // it: an honest absence from the transcript still leaves tokens to show.
    const reads: Promise<void>[] = [
      window.wanigan.usage.session(session.id).then((next) => {
        if (epoch !== requestEpoch.current) return;
        setUsage({ key, value: next });
      }),
    ];
    if (usesClaudeContextMeter) {
      reads.push(window.wanigan.transcripts.context(session.id).then((next) => {
        if (epoch !== requestEpoch.current) return;
        setCtx({ key, value: next });
      }));
    }
    void Promise.all(reads).then(() => undefined).catch((e) => {
      if (epoch !== requestEpoch.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }).finally(done);
  }, [contextKey, usesCodexAccountLimits, usesClaudeContextMeter, session.id]);
  useEffect(() => {
    // Clear the previous provider synchronously at the effect boundary. The
    // keyed reads below are the second guard against an async race.
    setStatus(null);
    setUsage(null);
    setCtx(null);
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
  const meter = ctx?.key === context.key ? ctx.value : null;
  const primary = label(codex?.primary ?? null, 'Now');
  const secondary = label(codex?.secondary ?? null, 'Week');
  const telemetry = selectedSessionTelemetry(sessionUsage, session.status);
  const ctxText = claudeContextLabel(meter);
  const ctxTitle = !context.usesClaudeContextMeter ? null
    : meter?.kind === 'ok'
      ? `Context: ${meter.tokens.toLocaleString('en-US')} tokens as of the last recorded turn.`
        + (meter.window
          ? ` The ${meter.percent}% reads against an assumed ${meter.window.toLocaleString('en-US')}-token window for ${meter.model ?? 'this model'} — the tokens are measured, the window is an assumption.`
          : ` No context window is known for ${meter.model ?? 'this model'}, so no percentage is invented.`)
      : meter?.kind === 'no-transcript'
        ? 'Context meter: no transcript found for this conversation yet.'
        : meter?.kind === 'no-usage'
          ? `Context meter: ${meter.detail}`
          : null;
  const loading = loadingKey === context.key;
  const sessionLine = `${context.label} · selected ${session.status} session${session.model ? ` · ${session.model}` : ''}`;
  const title = error
    ? `${sessionLine}\nStatus unavailable: ${error}\nClick to refresh this selected session.`
    : context.usesCodexAccountLimits
      ? [sessionLine, `Codex ${codex?.plan ?? 'account'} limits`, primary, secondary,
        'Account limits are shared across Codex sessions. Click to refresh now.'].filter(Boolean).join('\n')
      : [sessionLine, `Session telemetry: ${telemetry}.`, ctxTitle,
        'This provider does not expose account-plan remaining or reset time to Wanigan, so no quota is invented.',
        'Click to refresh this selected session.'].filter(Boolean).join('\n');
  const visible = context.usesCodexAccountLimits
    ? primary ?? (loading ? 'limits…' : 'Status unavailable')
    : error ? 'usage unavailable'
      : loading && !sessionUsage && !ctxText ? 'session…'
        : ctxText ? `${ctxText} · ${telemetry}` : telemetry;
  const nearFull = meter?.kind === 'ok' && meter.percent !== null && meter.percent >= 80;

  return (
    <button className={`nav-usage-status${(codex?.primary && codex.primary.remainingPercent <= 20) || nearFull ? ' low' : ''}`}
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
 * renders and drives it. The data half of the shape lives in shared/palette
 * so the smoke suite can hold the filter and grouping to account.
 */
/* ════════════════════════════════════════════════════════════════════════
   Halt and catch fire
   ════════════════════════════════════════════════════════════════════════ */

/**
 * The handle, in the header.
 *
 * Two clicks, never one, and the arm expires. This kills every agent in the
 * app; a control that did that on a single mis-click in permanent chrome would
 * be a control people move the window to avoid. It is also deliberately not red
 * until it has been armed — a button that is always shouting is one the eye
 * stops seeing, which is the opposite of what an emergency stop needs.
 */
function HaltControl({ halt, onChange }: { halt: HaltState | null; onChange: (next: HaltState) => void }) {
  const [armedAt, setArmedAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const armed = Date.now() - armedAt < HALT_ARM_MS;

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmedAt(0), HALT_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [armed, armedAt]);

  // While it is pulled the banner below owns the state and the way out of it.
  // A second control saying the same thing in the header would be one more
  // place for the two to disagree.
  if (halt?.halted) return null;

  return (
    <button className={`hdr-halt${armed ? ' armed' : ''}`} type="button" disabled={busy}
            title="Stop every agent, schedule and queue, and refuse to start anything until you clear it"
            aria-label={armed
              ? 'Confirm: stop every agent, schedule and queue'
              : 'Halt: stop every agent, schedule and queue'}
            onClick={() => {
              if (!armed) { setArmedAt(Date.now()); return; }
              setArmedAt(0);
              setBusy(true);
              window.wanigan.halt.pull()
                .then(onChange)
                .catch(() => {})
                .finally(() => setBusy(false));
            }}>
      {busy ? 'Stopping…' : armed ? 'Stop everything?' : 'Halt'}
    </button>
  );
}

/**
 * What a halted Wanigan says, on every screen.
 *
 * It reports what was stopped rather than asserting that everything was,
 * because those are different claims and one of them is not true: a batch the
 * API already accepted keeps running on Anthropic's machines whatever this
 * button does. The list comes from the stop pass itself, so a subsystem that
 * failed to stop says so here instead of being silently counted as stopped.
 */
function HaltBanner({ halt, onChange }: { halt: HaltState; onChange: (next: HaltState) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="halt-banner" role="alert">
      <div className="halt-banner-say">
        <strong>
          Wanigan is halted{halt.source === 'phone' ? ' — pulled from your phone' : ''}
          {halt.at ? ` ${ago(halt.at)}` : ''}.
        </strong>
        <p>
          Nothing will start until this is cleared: no session, no schedule, no queued task, no batch.
          Every tool call from anything still running is refused.
          {halt.reason ? ` Reason given: ${halt.reason}` : ''}
        </p>
        {halt.stopped.length > 0 && (
          <ul className="halt-what">
            {halt.stopped.map((entry) => (
              <li key={entry.name}>
                <span className="halt-n">{entry.stopped}</span> {entry.name}
                {entry.note ? <span className="halt-note"> — {entry.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button className="btn btn-primary" type="button" disabled={busy}
              onClick={() => {
                setBusy(true);
                window.wanigan.halt.clear()
                  .then(onChange)
                  .catch(() => {})
                  .finally(() => setBusy(false));
              }}>
        {busy ? 'Clearing…' : 'Clear the halt'}
      </button>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   The notification card
   ════════════════════════════════════════════════════════════════════════ */

/**
 * What a notification looks like when it is not allowed to leave the window.
 *
 * The transient twin of NeedYouPopover above, and the difference between them
 * is the whole reason this exists. That popover answers "what needs me right
 * now", read from a poll of current state; it is correct, and it is only ever
 * seen by somebody who already went looking. This one interrupts. It fires on a
 * transition — the moment an agent started waiting — and it stays put until it
 * is read or, for the states that stop mattering, until a timer takes it.
 *
 * Three separate surfaces now carry the same event: this card, the macOS
 * banner, and the phone. That is deliberate and it is not belt-and-braces. Of
 * the three, this is the only one whose delivery Wanigan controls: a banner is
 * shown at the operating system's discretion and reports nothing back, and a
 * phone alert depends on a push service and a device that may be in another
 * room. The card is what an operator looking at the window is promised.
 */
function AlertStack({ alerts, onOpen, onDismiss, onDismissAll }: {
  alerts: InAppAlertCard[];
  onOpen: (alert: InAppAlertCard) => void;
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
}) {
  // Non-urgent cards retire themselves; a permission wait does not.
  //
  // One sweep against a deadline stamped on each card, rather than a timeout
  // per card. The per-card version had `alerts` and `onDismiss` in its
  // dependencies, and `onDismiss` is an inline arrow in the shell — so every
  // App render tore the timers down and started them again from zero. That was
  // survivable until the halt poll landed: it refreshes every five seconds and
  // its result is a fresh object off the IPC boundary, so the shell now
  // re-renders on a guaranteed five-second cadence. Twelve seconds measured in
  // five-second instalments never elapses, and the cards stayed forever.
  //
  // A deadline cannot be reset by a re-render, because it was decided when the
  // card arrived.
  useEffect(() => {
    if (!alerts.some((alert) => !alert.urgent)) return;
    const sweep = window.setInterval(() => {
      const cutoff = Date.now() - IN_APP_ALERT_MS;
      for (const alert of alerts) if (!alert.urgent && alert.at <= cutoff) onDismiss(alert.id);
    }, 1_000);
    return () => window.clearInterval(sweep);
  }, [alerts, onDismiss]);

  return (
    <div className="alert-stack alert-inbox">
      {alerts.length > 1 && (
        <button className="alert-clear" type="button" onClick={onDismissAll}>
          Dismiss {alerts.length} notifications
        </button>
      )}
      {alerts.map((alert) => (
        <div key={alert.id}
             className={`alert-card${alert.urgent ? ' urgent' : ''}`}
             /* assertive for the urgent one only. A finished turn read out over
                whatever the operator was already having read to them is the
                behaviour that gets a screen reader user to turn the app off. */
             role={alert.urgent ? 'alert' : 'status'}>
          <div className="alert-identity">
            <span><span aria-hidden="true">{alert.urgent ? '!' : '✓'}</span> {alert.urgent ? 'Needs attention' : 'Update'}</span>
            <time dateTime={new Date(alert.at).toISOString()}>{new Date(alert.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
            <button className="alert-card-x" type="button" aria-label={`Dismiss: ${alert.title}`}
                    onClick={() => onDismiss(alert.id)}><Icon name="x" /></button>
          </div>
          <div className="alert-card-body">
            <div className="alert-card-title">{alert.title}</div>
            <div className="alert-card-text">{alert.body}</div>
          </div>
          <div className="alert-card-acts">
            {alert.target && (
              <button className="btn btn-primary btn-sm" type="button" onClick={() => onOpen(alert)}>
                {alert.target.kind === 'session' ? 'Open session' : 'Open run'}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A glyph-and-word mark before the title: a live session's attention state,
 *  "active" on the project the shell is pointed at, "current" on the theme. */
type PaletteMark = { glyph: string; word: string };
type PaletteItem = PaletteEntry & { run: () => void; mark?: PaletteMark };

function CommandPalette({ query, onQuery, items, transcriptRead, onClose, onRun }: {
  query: string; onQuery: (value: string) => void; items: PaletteItem[];
  transcriptRead: 'idle' | 'loading' | 'ready' | 'error';
  onClose: () => void; onRun: (item: PaletteItem) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  // Recent is read once per open: the palette closes on every run, so the
  // list cannot go stale while it is on screen. Shown only while the query is
  // empty — a search already ranks by what was typed — after Actions and
  // before the static Views list, so a frequent route is one arrow press away.
  // A Recent row is the original row under another header: same run, same
  // staysPut, so a remembered project row still stays put.
  const [recent] = useState<string[]>(readRecent);
  const withRecent = useMemo(() => {
    if (normalizedQuery || recent.length === 0) return items;
    const byKey = new Map(items.map((item) => [item.key, item] as const));
    const rows: PaletteItem[] = [];
    for (const key of recent) {
      const item = byKey.get(key);
      if (item) rows.push({ ...item, group: 'Recent', primary: false });
    }
    if (rows.length === 0) return items;
    const actions = items.filter((item) => item.group === 'Actions');
    const rest = items.filter((item) => item.group !== 'Actions');
    return [...actions, ...rows, ...rest];
  }, [items, normalizedQuery, recent]);
  const [scope, setScope] = useState('All');
  const matching = useMemo(() => filterPalette(withRecent, query), [withRecent, query]);
  const shown = useMemo(() => matching.filter(item => scope === 'All' || item.group === scope
    || (scope === 'Settings' && item.key.startsWith('action:appearance:'))), [matching, scope]);
  const groups = useMemo(() => groupPalette(shown), [shown]);
  const run = (item: PaletteItem) => { rememberRecent(item.key); onRun(item); };
  // Reaching the third result used to take three Tabs. One highlighted row,
  // moved with the arrow keys and taken with Enter, is what every palette on
  // this machine does; anything else is a list you have to walk.
  const [selected, setSelected] = useState<string | null>(null);
  const identity = (item: PaletteItem) => `${item.group}:${item.key}`;
  const active = shown.length === 0 ? -1 : Math.max(0, shown.findIndex(item => identity(item) === selected));
  const selectedItem = shown[active];
  useEffect(() => { setSelected(null); }, [normalizedQuery, scope]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-command-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      // Option rows carry tabIndex -1 and are skipped: Tab stays in the field,
      // and the highlight — not focus — is what moves through the results.
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((item) => item.getClientRects().length > 0 && item.tabIndex >= 0);
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
    if (shown.length === 0 || e.nativeEvent.isComposing || document.activeElement !== input.current) return;
    const step = (delta: number) => {
      e.preventDefault();
      setSelected(identity(shown[(active + delta + shown.length) % shown.length]));
      input.current?.focus();
    };
    if (e.key === 'ArrowDown') return step(1);
    if (e.key === 'ArrowUp') return step(-1);
    if (!normalizedQuery && e.key === 'Home') { e.preventDefault(); setSelected(identity(shown[0])); return; }
    if (!normalizedQuery && e.key === 'End') { e.preventDefault(); setSelected(identity(shown[shown.length - 1])); return; }
    // A row that already has focus activates itself; Enter is only ours while
    // the caret is still in the field.
    if (e.key === 'Enter' && document.activeElement === input.current && active >= 0) {
      e.preventDefault();
      run(shown[active]);
    }
  };

  return (
    <div className="command-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialog} className="command-palette command-workspace" role="dialog" aria-modal="true"
               aria-label="Go to a view, project or session"
               onKeyDown={onDialogKeyDown} onMouseDown={(e) => e.stopPropagation()}>
        <div className="command-search">
        <Icon name="search" />
        <input ref={input} className="field" value={query} onChange={(e) => onQuery(e.target.value)}
               placeholder="Where do you want to go?"
               aria-label="Search views, projects, live sessions, settings and archived transcripts"
               role="combobox" aria-expanded={shown.length > 0} aria-autocomplete="list"
               aria-controls="wanigan-command-results"
               aria-activedescendant={active >= 0 ? `wanigan-command-${active}` : undefined} />
        <button className="command-close" type="button" onClick={onClose} aria-label="Close command search"><Icon name="x" /></button>
        </div>
        <div className="command-scopes" role="group" aria-label="Search category">
          {['All', 'Views', 'Projects', 'Live sessions', 'Settings', 'Transcripts'].map(value =>
            <button type="button" key={value} aria-pressed={scope === value} onClick={() => { setScope(value); input.current?.focus(); }}>{value === 'Live sessions' ? 'Sessions' : value}</button>)}
        </div>
        <div className="command-layout">
        <div ref={list} id="wanigan-command-results" className="command-results" role="listbox"
             aria-label="Results">
          {shown.length === 0 ? <div className="command-empty"><Icon name="search" /><strong>No matches here.</strong><p>Try a shorter name or search another category.</p>{scope !== 'All' && <button className="btn" type="button" onClick={() => setScope('All')}>Search everything</button>}</div> : (() => {
            let flat = -1;
            return groups.map((group) => (
              <div key={group.label} role="group" aria-label={`${group.label}, ${group.items.length} results`}>
                {/* Counts rows on screen. Transcripts are capped by the FTS ask,
                    so a full page says "shown" rather than claiming a total. */}
                <div role="presentation" className="command-group-label">
                  {group.label} · {group.items.length}{group.label === 'Transcripts' && group.items.length >= TRANSCRIPT_RESULT_CAP ? ' shown' : ''}
                </div>
                {group.items.map((item) => {
                  flat += 1;
                  const index = flat;
                  return (
                    // Out of the Tab order on purpose: this is an APG combobox, so Tab
                    // stays in the field and the highlight travels by arrow key. The
                    // highlight paints from .command-item[aria-selected="true"] in
                    // index.css — the rule this row used to mirror inline for want of one.
                    <button key={identity(item)} id={`wanigan-command-${index}`} type="button" role="option" tabIndex={-1}
                            className={`command-item${item.primary ? ' command-item-primary' : ''}`}
                            aria-selected={index === active} data-command-active={index === active}
                            onMouseEnter={() => setSelected(identity(item))}
                            onClick={() => run(item)}>
                      <span className="command-item-copy">
                        <strong>
                          {item.mark && (
                            <span className="mark"><span className="glyph" aria-hidden="true">{item.mark.glyph}</span>{item.mark.word}</span>
                          )}
                          {item.title}
                        </strong>
                        <small>{item.hint}</small>
                      </span>
                      <span className="faint mono">{item.meta}</span>
                    </button>
                  );
                })}
              </div>
            ));
          })()}
        </div>
        <aside className="command-preview" aria-label="Selected result">
          {selectedItem ? <><span className="command-preview-kind">{selectedItem.group}</span>
            <Icon name={selectedItem.group === 'Live sessions' ? 'terminal' : selectedItem.group === 'Projects' ? 'reveal' : selectedItem.group === 'Settings' ? 'sliders' : 'search'} />
            <h2>{selectedItem.title}</h2><p>{selectedItem.hint}</p>
            {selectedItem.mark && <p className="command-preview-mark">{selectedItem.mark.glyph} {selectedItem.mark.word}</p>}
            <span className="command-preview-action"><kbd>↵</kbd> {selectedItem.staysPut ? 'Apply selection' : 'Open selection'}</span>
          </> : <p>Your next destination will appear here.</p>}
        </aside>
        </div>
        <div className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> move <kbd>↵</kbd> open</span>
          <span role="status">{transcriptRead === 'loading' ? 'Searching transcripts…' : transcriptRead === 'error' ? 'Transcript search unavailable. Other results are still available.' : scope === 'Transcripts' && normalizedQuery.length < TRANSCRIPT_QUERY_MIN ? 'Type at least 3 characters to search transcripts.' : `${shown.length} results shown`}</span>
        </div>
      </section>
    </div>
  );
}

function NavTab({ id, tab, go, label, badge, progress, marks, onKeyDown, roving }: {
  id: Tab; tab: Tab; go: (t: Tab) => void; label: string;
  /** An inert count. Rendered inside the row, between the word and the chord. */
  badge?: React.ReactNode;
  /** An inert bar. Rendered under the row so it cannot squeeze the label. */
  progress?: React.ReactNode;
  /** Marks that are doors. Rendered as siblings of the row, never inside it:
   *  a button inside a button is invalid HTML and reads as one control. This
   *  is the wrapper split the Sessions tab strip already uses. */
  marks?: React.ReactNode;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, current: Tab) => void;
  /** The list's single tab stop. It follows arrow-key focus, not the view. */
  roving: Tab;
}) {
  const on = tab === id;
  const shortcut = TAB_SHORTCUTS[id];
  return (
    <div className="nav-tab-wrap">
      <button className={`nav-tab${on ? ' on' : ''}`} type="button" data-nav-tab={id}
              tabIndex={roving === id ? 0 : -1} onClick={() => go(id)} onKeyDown={(event) => onKeyDown(event, id)}
              aria-current={on ? 'page' : undefined}
              aria-keyshortcuts={shortcut.aria}
              title={`${label} (${shortcut.label})`}>
        {/* The glyph is a second way to find a row, never the only one: the
            word is always printed beside it. At 176px the label is what still
            fits; the icon is what makes the column scannable at a glance. */}
        <Icon name={TAB_ICONS[id]} />
        <span className="nav-tab-label">{label}</span>
        {badge}
        <span className="nav-tab-chord" aria-hidden="true">{shortcut.label}</span>
      </button>
      {progress}
      {marks}
    </div>
  );
}
