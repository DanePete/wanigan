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
import ThemeControl from './components/ThemeControl';
import { useThemePreference } from './theme';

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
type TabGroup = (typeof TABS)[number]['group'];

const TAB_GROUPS: readonly TabGroup[] = ['Work', 'Explore', 'Manage'];

// The wide rail prioritises the surfaces used continuously while an agent is
// running. Skills and Context stay one keypress away in Views/⌘K without
// changing the long-standing ⌘1–9 map or turning the rail into a ticker.
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

/** Motion is a setting, not a guess: 'auto' follows the OS, the other two win. */
function motionOn(): boolean {
  const m = document.documentElement.dataset.motion;
  if (m === 'off') return false;
  if (m === 'full') return true;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('sessions');
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
  const [error, setError] = useState<string | null>(null);
  const [startup, setStartup] = useState<StartupStatus | null>(null);
  const [retryingStartup, setRetryingStartup] = useState(false);
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  // The palette is a real modal. Remember where it came from so Escape and a
  // backdrop click put a keyboard user straight back where they started.
  const paletteOpenerRef = useRef<HTMLElement | null>(null);
  // The horizontal rail stays finger-scrollable at every width. This menu is
  // its explicit, keyboard-friendly companion: no destination becomes a
  // mystery just because it sits beyond the current slice of the rail.
  const [navMenuOpen, setNavMenuOpen] = useState(false);
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

  const loadShell = useCallback(async () => {
    const [pv, pj, ks] = await Promise.all([
      window.wanigan.providers.list(),
      window.wanigan.projects.list(),
      window.wanigan.key.status(),
    ]);
    setProviders(pv); setProjects(pj); setHasKey(ks.present);
  }, []);

  useEffect(() => {
    void loadShell().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [loadShell]);

  // The attended main process registers this channel before it touches the
  // database. A corrupted or partially migrated legacy DB therefore produces
  // a visible recovery banner instead of a window that looks empty or absent.
  useEffect(() => {
    let mounted = true;
    void window.wanigan.startup.status()
      .then((state) => { if (mounted) setStartup(state); })
      .catch((e) => { if (mounted) setError(e instanceof Error ? e.message : String(e)); });
    const off = window.wanigan.on.startupChanged((state) => {
      if (mounted) setStartup(state);
    });
    return () => { mounted = false; off(); };
  }, []);

  const retryStartup = useCallback(() => {
    setRetryingStartup(true);
    void window.wanigan.startup.retry()
      .then(setStartup)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRetryingStartup(false));
  }, []);

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
    setNavMenuOpen(false);
    if (next === tabRef.current) return;
    const swap = () => setTab(next);
    const doc = document as ViewTransitionDoc;
    // A live PTY on either side of the swap means no transition at all.
    const touchesPty =
      (next === 'sessions' || tabRef.current === 'sessions') && sessionsRef.current.length > 0;
    if (touchesPty || !motionOn() || typeof doc.startViewTransition !== 'function') { swap(); return; }
    doc.startViewTransition(() => { flushSync(swap); });
  }, []);

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

  const addProject = useCallback(async () => {
    try {
      const p = await window.wanigan.projects.pick();
      if (p) { setProjects(await window.wanigan.projects.list()); choose(p.id); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [choose]);

  const removeProject = useCallback(async (id: string) => {
    setProjects(await window.wanigan.projects.remove(id));
  }, []);

  // ── nav chrome ─────────────────────────────────────────────────────
  const tabsRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<HTMLSpanElement>(null);
  const navMenuRef = useRef<HTMLDivElement>(null);
  const navMenuButtonRef = useRef<HTMLButtonElement>(null);
  const placed = useRef(false);
  const runBadge = useRef<HTMLSpanElement>(null);
  const needBadge = useRef<HTMLSpanElement>(null);
  const lastNeeds = useRef(0);

  const closeNavMenu = useCallback((restoreFocus = false) => {
    setNavMenuOpen(false);
    if (restoreFocus) requestAnimationFrame(() => navMenuButtonRef.current?.focus());
  }, []);

  const focusMenuItem = useCallback((edge: 'first' | 'last') => {
    requestAnimationFrame(() => {
      const items = Array.from(navMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
      items[edge === 'first' ? 0 : items.length - 1]?.focus();
    });
  }, []);

  // The visible strip behaves like a compact toolbar. Tab enters the active
  // route once, and Left/Right (or Home/End) walks every visible route without
  // asking a keyboard user to tab through eleven tiny controls.
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
    go(next);
    requestAnimationFrame(() => {
      tabsRef.current?.querySelector<HTMLButtonElement>(`[data-nav-tab="${next}"]`)?.focus();
    });
  }, [go]);

  const onNavMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(navMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeNavMenu(true);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const next = activeIndex < 0
        ? (direction > 0 ? 0 : items.length - 1)
        : (activeIndex + direction + items.length) % items.length;
      items[next]?.focus();
    }
  }, [closeNavMenu]);

  useEffect(() => {
    if (!navMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (navMenuRef.current?.contains(target) || navMenuButtonRef.current?.contains(target)) return;
      closeNavMenu();
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [navMenuOpen, closeNavMenu]);

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

  // ⌘⇧D from anywhere: a demo toggle you have to go and find is one you forget
  // to turn on until after the screenshot.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key.toLowerCase() !== 'd') return;
      e.preventDefault();
      void window.wanigan.demo.state()
        .then((s) => window.wanigan.demo.set(!s.on))
        .then(() => window.location.reload());
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="shell">
      {startup?.phase === 'recovery' && (
        <section className="startup-recovery" role="alert" aria-live="assertive">
          <div>
            <strong>Wanigan is open in recovery mode.</strong>
            <span>{startup.stage ?? 'Startup'}: {startup.message ?? 'Unknown local-data error.'}</span>
            <small>No data was changed by this recovery screen. Fix the local-data issue, then retry or restart Wanigan.</small>
          </div>
          <button className="btn" type="button" onClick={retryStartup} disabled={retryingStartup}>
            {retryingStartup ? 'Retrying…' : 'Retry local services'}
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
            {tab === 'learning' && projects.length > 1 && (
              <label className="nav-project">
                <span className="label">Project</span>
                <select className="field" value={projectId ?? ''} onChange={(e) => choose(e.target.value)}
                        title="Which project's learning, skills, and context to read">
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}

            <button className="nav-new-session" type="button" onClick={requestNewSession}
                    title="Start a new interactive agent session (⌘T)"
                    aria-label="Start a new interactive agent session (Command T)">
              <span className="nav-new-session-plus" aria-hidden="true">+</span>
              <span className="nav-new-session-label">New session</span>
              <span className="nav-shortcut" aria-hidden="true">⌘T</span>
            </button>

            <div className="nav-views">
              <button ref={navMenuButtonRef} className={`nav-views-button${railHasActiveTab ? '' : ' on'}`} type="button"
                      aria-expanded={navMenuOpen} aria-controls="wanigan-view-menu" aria-haspopup="menu"
                      aria-current={railHasActiveTab ? undefined : 'page'}
                      title="Browse every view (⌘K)"
                      onClick={() => setNavMenuOpen((open) => !open)}
                      onKeyDown={(event) => {
                        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Escape') return;
                        event.preventDefault();
                        if (event.key === 'Escape') { closeNavMenu(true); return; }
                        setNavMenuOpen(true);
                        focusMenuItem(event.key === 'ArrowDown' ? 'first' : 'last');
                      }}>
                <span>Views</span>
                <span className="nav-views-shortcut" aria-hidden="true">⌘K</span>
                <span className="nav-views-caret" aria-hidden="true">⌄</span>
              </button>
              {navMenuOpen && (
                <div ref={navMenuRef} id="wanigan-view-menu" className="nav-menu" role="menu"
                     aria-label="All Wanigan views" onKeyDown={onNavMenuKeyDown}>
                  {TAB_GROUPS.map((group) => (
                    <div className="nav-menu-group" role="group" aria-label={`${group} views`} key={group}>
                      <span className="nav-menu-group-label">{group}</span>
                      {TABS.filter((item) => item.group === group).map((item) => (
                        <button className={`nav-menu-item${tab === item.id ? ' on' : ''}`} type="button" role="menuitem"
                                aria-current={tab === item.id ? 'page' : undefined} key={item.id}
                                onClick={() => go(item.id)}>
                          <span>{item.label}</span>
                          <span className="nav-menu-shortcut" aria-hidden="true">{shortcutForTab(item.id)}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button className="nav-quick-run" type="button" onClick={() => go('runs')}
                    title="Open headless Runs (⌘0)">
              <span className="nav-quick-run-plus" aria-hidden="true">+</span>
              <span className="nav-quick-run-headless">Headless</span>
              <span>runs</span>
              <span className="nav-shortcut" aria-hidden="true">⌘0</span>
            </button>

            {providers.some((p) => p.id === 'codex' && p.path) && <CodexStatusBadge />}
            <ThemeControl preference={theme.preference} resolved={theme.resolved} onChange={theme.setTheme} />
          </div>
        </div>

        <nav className="nav" aria-label="Primary navigation">
          <div className="nav-tabs" ref={tabsRef} role="toolbar" aria-label="Wanigan views">
            <NavTab id="sessions" n={1} tab={tab} go={go} label="Sessions" tabStop={!railHasActiveTab} onKeyDown={onNavTabKeyDown}>
              {running > 0 && (
                <span className="nav-badge mo-breathe" ref={runBadge}
                      title={`${running} session${running === 1 ? '' : 's'} running`}>{running}</span>
              )}
            </NavTab>
            <NavTab id="fleet" n={2} tab={tab} go={go} label="Fleet" onKeyDown={onNavTabKeyDown}>
              {mark && (
                <span className={`nav-mark tone-${mark.tone}`} ref={needBadge}
                      title={`${needs.detail} — open Fleet (⌘2)`}>
                  <span aria-hidden="true">{mark.glyph}</span>{needs.total} need you
                </span>
              )}
            </NavTab>
            <NavTab id="control" n={3} tab={tab} go={go} label="Control" onKeyDown={onNavTabKeyDown} />
            <NavTab id="batches" n={4} tab={tab} go={go} label="Batches" onKeyDown={onNavTabKeyDown}>
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
            <NavTab id="insights" n={5} tab={tab} go={go} label="Insights" onKeyDown={onNavTabKeyDown} />
            <NavTab id="learning" n={6} tab={tab} go={go} label="Learning" onKeyDown={onNavTabKeyDown} />
            <NavTab id="plugins"  n={7} tab={tab} go={go} label="Plugins" onKeyDown={onNavTabKeyDown} />
            <NavTab id="schedules" n={8} tab={tab} go={go} label="Schedules" onKeyDown={onNavTabKeyDown} />
            <NavTab id="git"      n={9} tab={tab} go={go} label="Git" onKeyDown={onNavTabKeyDown} />
            <NavTab id="runs"     n={0} tab={tab} go={go} label="Runs" onKeyDown={onNavTabKeyDown} />
            <NavTab id="settings" tab={tab} go={go} label="Settings" onKeyDown={onNavTabKeyDown}>
              {!hasKey && (
                <span className="nav-mark tone-warn" title="No API key set — add one in Settings before submitting a batch">
                  <span aria-hidden="true">!</span>no key
                </span>
              )}
            </NavTab>
            <span className="nav-ink" ref={inkRef} aria-hidden="true" />
          </div>
        </nav>
      </header>

      <div className="body">
        {tab === 'sessions' && (
          <Sessions providers={providers} projects={projects}
                    onAddProject={addProject} onError={setError}
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
        {tab === 'learning' && <Learning projectId={projectId} projects={projects} providers={providers} />}
        {tab === 'skills' && <Skills projectId={projectId} activeSessionId={activeSessionId} />}
        {tab === 'context' && <Context projectId={projectId} projects={projects} />}
        {tab === 'plugins' && <Plugins />}
        {tab === 'schedules' && <Schedules projects={projects} />}
        {tab === 'git' && <Git projects={projects} />}
        {tab === 'runs' && <HeadlessRuns projects={projects} providers={providers} />}
        {tab === 'settings' && (
          <SettingsView providers={providers} projects={projects}
                        onKeyChange={loadShell} onRemoveProject={removeProject} onAddProject={addProject}
                        themePreference={theme.preference} resolvedTheme={theme.resolved} onThemeChange={theme.setTheme} />
        )}
      </div>

      {error && (
        <div className="toast" onClick={() => setError(null)} role="alert">
          {error} <span className="faint">— click to dismiss</span>
        </div>
      )}
      {palette && (
        <CommandPalette
          query={paletteQuery}
          onQuery={setPaletteQuery}
          onClose={closePalette}
          onChoose={(id) => { closePalette(false); go(id); }}
          onNewSession={() => { closePalette(false); requestNewSession(); }}
        />
      )}
    </div>
  );
}

/** Your Codex limit windows, without sending /status through a live agent. */
function CodexStatusBadge() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback((force = false) => {
    void window.wanigan.codex.status(force).then((next) => {
      setStatus(next); setError(null);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(() => load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const label = (window: CodexStatus['primary'], short: string) => {
    if (!window) return null;
    const reset = window.resetsAt ? ` · resets ${relativeReset(window.resetsAt)}` : '';
    return `${short} ${window.remainingPercent}% left${reset}`;
  };
  const primary = label(status?.primary ?? null, 'Now');
  const secondary = label(status?.secondary ?? null, 'Week');
  const title = error
    ? `Codex status unavailable: ${error}`
    : status
      ? [`Codex ${status.plan ?? 'account'} limits`, primary, secondary, 'Click to refresh now.'].filter(Boolean).join('\n')
      : 'Reading your Codex status…';

  return (
    <button className={`nav-codex-status${status?.primary && status.primary.remainingPercent <= 20 ? ' low' : ''}`}
            title={title} aria-label={title} onClick={() => load(true)}>
      {status ? <><span className="faint">Codex</span> {primary ?? 'Status unavailable'}{secondary && <span className="nav-codex-week">· {secondary}</span>}</>
        : error ? <><span className="faint">Codex</span> status unavailable</>
          : <><span className="faint">Codex</span> status…</>}
    </button>
  );
}

function relativeReset(at: number): string {
  const mins = Math.max(0, Math.round((at - Date.now()) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function shortcutForTab(id: Tab): string {
  const index = TABS.findIndex((item) => item.id === id);
  if (index >= 0 && index < 9) return `⌘${index + 1}`;
  return id === 'runs' ? '⌘0' : '';
}

function CommandPalette({ query, onQuery, onClose, onChoose, onNewSession }: {
  query: string; onQuery: (value: string) => void; onClose: () => void; onChoose: (id: Tab) => void;
  onNewSession: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const shown = TABS.filter((item) => `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(normalizedQuery));
  const showNewSession = !normalizedQuery
    || 'new session'.includes(normalizedQuery)
    || 'start agent'.includes(normalizedQuery)
    || 'interactive'.includes(normalizedQuery);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((item) => item.getClientRects().length > 0);
      if (focusable.length === 0) { e.preventDefault(); return; }
      const active = document.activeElement;
      const index = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
      if (e.shiftKey && index <= 0) { e.preventDefault(); focusable[focusable.length - 1]?.focus(); }
      if (!e.shiftKey && (index < 0 || index === focusable.length - 1)) { e.preventDefault(); focusable[0]?.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="command-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialog} className="command-palette" role="dialog" aria-modal="true" aria-label="Go to a Wanigan view"
               onMouseDown={(e) => e.stopPropagation()}>
        <input ref={input} className="field" value={query} onChange={(e) => onQuery(e.target.value)}
               placeholder="Go to a view or start a session…" aria-label="Search views and actions" />
        <div className="command-results">
          {showNewSession && (
            <button className="command-item command-item-primary" type="button" onClick={onNewSession}>
              <span className="command-item-copy"><strong>New session</strong><small>Start an interactive agent</small></span>
              <span className="faint mono">⌘T</span>
            </button>
          )}
          {shown.length === 0 && !showNewSession ? <p className="faint">No matching view or action.</p> : shown.map((item) => (
            <button key={item.id} className="command-item" onClick={() => onChoose(item.id)}>
              <span>{item.label}</span>
              <span className="faint mono">{shortcutForTab(item.id)}</span>
            </button>
          ))}
        </div>
        <p className="faint" style={{ margin: '8px 0 0', fontSize: 'var(--t-small)' }}>Esc closes · ⌘K opens</p>
      </section>
    </div>
  );
}

function NavTab({ id, n, tab, go, label, children, onKeyDown, tabStop = false }: {
  id: Tab; n?: number; tab: Tab; go: (t: Tab) => void; label: string; children?: React.ReactNode;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, current: Tab) => void;
  tabStop?: boolean;
}) {
  const on = tab === id;
  return (
    <button className={`nav-tab${on ? ' on' : ''}`} type="button" data-nav-tab={id}
            tabIndex={on || tabStop ? 0 : -1} onClick={() => go(id)} onKeyDown={(event) => onKeyDown(event, id)}
            aria-current={on ? 'page' : undefined}
            aria-keyshortcuts={n === undefined ? undefined : n === 0 ? 'Meta+0 Control+0' : `Meta+${n} Control+${n}`}
            title={n === undefined ? label : `${label} (⌘${n})`}>
      {label}
      {children}
    </button>
  );
}
