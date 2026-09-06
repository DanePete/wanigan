import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Attention, AttentionKind, ClaudeContextUsage, MotionSetting, Project, ProviderInfo, Session, ThemeSetting, TranscriptHit } from '@shared/types';
import { filterPalette, groupPalette, transcriptHitRow, TRANSCRIPT_QUERY_MIN, TRANSCRIPT_RESULT_CAP, type PaletteEntry } from '@shared/palette';
import { DIGIT_ROUTES, SIDEBAR_GROUPS, TABS, TAB_ICONS, TAB_SHORTCUTS, labelForTab, type Tab } from '@shared/routes';
import { bindingMatches, inTerminal, modalOpen } from './bindings';
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
import ImprovementScout from './views/ImprovementScout';
import UsageView from './views/Usage';
import SettingsView, { SETTINGS_INDEX, type SettingsJump } from './views/Settings';
import Skills from './views/Skills';
import Context from './views/Context';
import { Icon, ago, num } from './components/bits';
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
 *  - Nothing animates around a live terminal. A view transition that fades or
 *    slides a pane containing a running PTY fights xterm's own repaint, and the
 *    thing that ends up looking broken is the terminal. When either side of a
 *    view swap holds a live session, the swap is instant on purpose.
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
    return goal ? 'control' : 'sessions';
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
const attentionShape = (l: Attention[]) => l.map((a) => `${a.sessionId}:${a.kind}:${a.since}`).join('|');
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
  const [settingsJump, setSettingsJump] = useState<SettingsJump | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
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
  // Starts open. The stored answer arrives a frame later; rendering closed
  // until then would flash the shell narrow for everyone who never hid it.
  const [sidebarOpen, setSidebarOpen] = useState(true);
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
  // Destructured so the palette corpus can depend on the three fields rather
  // than on an object whose identity changes every render.
  const { preference: themePreference, resolved: themeResolved, setTheme } = theme;

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

  // ── sidebar ────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try { setSidebarOpen((await window.wanigan.prefs.all()).navSidebar !== 'closed'); }
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
    const [ss, flight, att] = await Promise.all([
      window.wanigan.sessions.list().catch(() => [] as Session[]),
      // null, not an empty read: a badge is a claim about what is running, and
      // a call that failed has observed nothing to claim it from.
      window.wanigan.batch.runsInFlight().catch(() => null),
      window.wanigan.attention.list().catch(() => [] as Attention[]),
    ]);
    // Poll results are only allowed to re-render the app when they actually
    // differ — a new array every six seconds would re-render the view holding
    // the terminals for nothing.
    setSessions((prev) => (shape(prev) === shape(ss) ? prev : ss));

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
    const t = setInterval(() => { if (document.hidden) return; void tick(); }, 6000);
    const offBatch = window.wanigan.on.batchChanged(() => void tick());
    const offList = window.wanigan.on.sessions((list) =>
      setSessions((prev) => (shape(prev) === shape(list) ? prev : list)));
    return () => { clearInterval(t); offBatch(); offList(); };
  }, [tick]);

  // Branches move constantly; keep the shared project list honest. Handing
  // `setProjects` the refresh result directly installed a new array identity
  // every thirty seconds whether or not a branch had actually moved, and
  // `projects` is a prop of a dozen views — so compare first, the way the
  // session and attention polls above already do.
  const refreshProjects = useCallback(() => {
    window.wanigan.projects.refresh()
      .then((list) => setProjects((prev) => (projectShape(prev) === projectShape(list) ? prev : list)))
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
  const openGoal = useCallback((id: string) => {
    window.history.replaceState(null, '', `#goal=${encodeURIComponent(id)}`);
    go('control');
  }, [go]);

  const focusSession = useCallback((id: string, projectId?: string) => {
    setActiveSessionId(id);
    const project = projectId ?? sessionsRef.current.find((x) => x.id === id)?.projectId;
    if (project) choose(project);
  }, [choose]);

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

  // ── demo mode ───────────────────────────────────────────
  // Read once at start-up. demo:set reloads the window, so there is no state
  // to keep in sync afterwards — the next mount reads the new answer.
  //
  // The terminal blur is re-applied here, and only here. It used to be a
  // localStorage flag written by a checkbox that exists only while Settings ›
  // Demo mode is open and demo mode is already on, so the reload demo:set
  // performs came back with masked names and an unblurred terminal — the
  // half-masked screenshot that is worse than no masking, because it looks
  // done. This component always mounts, so it is the only place the preference
  // can be applied before a terminal draws.
  //
  // Blurred is where it starts, before the read has answered. An unblurred
  // terminal is raw agent output on a screen someone may be sharing; a blurred
  // one costs a caption for as long as one IPC call takes. Only an answer
  // clears it, so a read that fails leaves the terminal covered and reports
  // itself rather than quietly uncovering it.
  useEffect(() => {
    let mounted = true;
    const blur = (on: boolean) => document.documentElement.toggleAttribute('data-demo-blur', on);
    blur(true);
    const read = () => window.wanigan.demo.state().then((s) => {
      if (!mounted) return;
      setDemoOn(s.on);
      blur(s.on && s.blurTerminals);
    });
    // One-shot, for an operator who ticked the box while it was still a browser
    // flag. The stored setting is written first and the flag dropped second, so
    // a failed write leaves the old preference where it is and the next launch
    // tries again, instead of silently turning the blur off.
    const carryOverLegacyFlag = async () => {
      let legacy: string | null = null;
      try { legacy = localStorage.getItem('wanigan.demo.blurTerminal'); }
      catch { return; }  // blocked storage: there is no old preference to carry
      if (legacy === null) return;
      if (legacy === '1') await window.wanigan.demo.setBlur(true);
      try { localStorage.removeItem('wanigan.demo.blurTerminal'); } catch { /* nothing to clean up */ }
    };
    void carryOverLegacyFlag()
      .catch(() => { /* the read below is what reports the setting either way */ })
      .then(read)
      .catch((e) => {
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
    if (q.length < TRANSCRIPT_QUERY_MIN) { setPaletteHits([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      window.wanigan.transcripts.search(q, TRANSCRIPT_RESULT_CAP)
        .then((hits) => { if (!cancelled) setPaletteHits(hits); })
        .catch(() => { if (!cancelled) setPaletteHits([]); });
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
    <div className="shell">
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
      <div className="workspace">
        {sidebarOpen && (
          <nav className="sidebar" id="wanigan-sidebar" aria-label="Primary navigation">
            <div className="sidebar-scroll" ref={tabsRef} role="toolbar" aria-label="Wanigan views" aria-orientation="vertical">
              {SIDEBAR_GROUPS.map((section) => (
                <div className="sidebar-group" key={section.group}>
                  <div className="sidebar-group-label">{section.group}</div>
                  {section.tabs.map((id) => (
                    <NavTab key={id} id={id} tab={tab} go={go} label={labelForTab(id)}
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
          {tab === 'sessions' && (
            <Sessions providers={providers} projects={projects}
                      onAddProject={addProject} onError={reportSessionError}
                      activeId={activeSessionId} onActiveChange={focusSession}
                      newSessionRequest={newSessionRequest} onNewSessionRequestConsumed={consumeNewSessionRequest}
                      onSendToBatch={(seed) => { setBatchSeed(seed); go('batches'); }} />
          )}
          {tab === 'fleet' && <Fleet projects={projects} onOpenSession={openSession} onNewSession={requestNewSession} />}
          {tab === 'control' && <Control projects={projects} providers={providers} onOpenSession={openSession} />}
          {tab === 'batches' && (
            <Batches projects={projects} hasKey={hasKey} onNeedKey={() => go('settings')}
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
            <Context projectId={projectId} projects={projects}
                     onReloadProjects={loadShell} onOpenLearning={openLearning} />
          )}
          {tab === 'plugins' && <Plugins />}
          {tab === 'schedules' && <Schedules projects={projects} />}
          {tab === 'git' && <Git projects={projects} />}
          {tab === 'runs' && <HeadlessRuns projects={projects} providers={providers} />}
          {tab === 'settings' && (
            <SettingsView providers={providers} projects={projects} jump={settingsJump}
                          onKeyChange={loadShell} onRemoveProject={removeProject} onAddProject={addProject}
                          themePreference={theme.preference} resolvedTheme={theme.resolved} onThemeChange={theme.setTheme} />
          )}
          </ViewMemoryScope>
        </ErrorBoundary>
      </div>
      </div>

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
        <DemoConfirm next={demoPrompt.next} busy={demoBusy}
                     onCancel={() => setDemoPrompt(null)}
                     onConfirm={() => applyDemo(demoPrompt.next)} />
      )}
      {shortcuts && <ShortcutSheet onClose={() => setShortcuts(false)} />}
      {needAnchor && (
        <NeedYouPopover anchor={needAnchor} attention={attention} sessions={sessions}
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
function NeedYouPopover({ anchor, attention, sessions, onOpen, onClose }: {
  anchor: HTMLElement; attention: Attention[]; sessions: Session[];
  onOpen: (sessionId: string) => void; onClose: () => void;
}) {
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'first' });
  const rows = attention.filter((a) => NEEDS_YOU.includes(a.kind));
  // Anchored under the mark that opened it, from measured geometry; clamped
  // so the panel never runs off the right edge on a narrow window.
  const rect = anchor.getBoundingClientRect();
  const place = {
    '--pop-left': `${Math.max(8, Math.min(rect.left, window.innerWidth - 372))}px`,
    '--pop-top': `${Math.round(rect.bottom + 6)}px`,
  } as React.CSSProperties;
  return portal(
    <div {...backdropProps} className="overlay-backdrop clear">
      <section {...dialogProps} className="need-popover" aria-label="Sessions that need you" style={place}>
        <h2>{rows.length === 0 ? 'Nothing is waiting on you now' : `${rows.length} need you — worst first`}</h2>
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
                <span className="need-row-project">{project}{a.detail ? ` · ${a.detail}` : ''}</span>
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
        <button className="btn btn-primary" type="button" onClick={onConfirm} disabled={busy}>
          {busy ? 'Applying…' : next ? 'Turn on and reload' : 'Turn off and reload'}
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
/** A glyph-and-word mark before the title: a live session's attention state,
 *  "active" on the project the shell is pointed at, "current" on the theme. */
type PaletteMark = { glyph: string; word: string };
type PaletteItem = PaletteEntry & { run: () => void; mark?: PaletteMark };

function CommandPalette({ query, onQuery, items, onClose, onRun }: {
  query: string; onQuery: (value: string) => void; items: PaletteItem[];
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
  const shown = useMemo(() => filterPalette(withRecent, query), [withRecent, query]);
  const groups = useMemo(() => groupPalette(shown), [shown]);
  const run = (item: PaletteItem) => { rememberRecent(item.key); onRun(item); };
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
      run(shown[active]);
    }
  };

  return (
    <div className="command-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialog} className="command-palette" role="dialog" aria-modal="true"
               aria-label="Go to a view, project or session"
               onKeyDown={onDialogKeyDown} onMouseDown={(e) => e.stopPropagation()}>
        <input ref={input} className="field" value={query} onChange={(e) => onQuery(e.target.value)}
               placeholder="Go to a view, project, session or setting — or search transcripts…"
               aria-label="Search views, projects, live sessions, settings and archived transcripts"
               role="combobox" aria-expanded={shown.length > 0} aria-autocomplete="list"
               aria-controls="wanigan-command-results"
               aria-activedescendant={active >= 0 ? `wanigan-command-${active}` : undefined} />
        <div ref={list} id="wanigan-command-results" className="command-results" role="listbox"
             aria-label="Results">
          {shown.length === 0 ? <p className="faint">No matching view, project, session, setting, transcript or action.</p> : (() => {
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
                    <button key={item.key} id={`wanigan-command-${index}`} type="button" role="option" tabIndex={-1}
                            className={`command-item${item.primary ? ' command-item-primary' : ''}`}
                            aria-selected={index === active} data-command-active={index === active}
                            onMouseEnter={() => setSelected(index)}
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
        <p className="faint" style={{ margin: '8px 0 0', fontSize: 'var(--t-small)' }}>
          ↑↓ moves · Enter opens · Esc closes · ⌘K closes
        </p>
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
