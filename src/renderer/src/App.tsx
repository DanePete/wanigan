import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Attention, AttentionKind, MotionSetting, Project, ProviderInfo, Session } from '@shared/types';
import Sessions from './views/Sessions';
import Fleet from './views/Fleet';
import Batches from './views/Batches';
import InsightsView from './views/Insights';
import Skills from './views/Skills';
import Plugins from './views/Plugins';
import Schedules from './views/Schedules';
import Context from './views/Context';
import SettingsView from './views/Settings';
import { num } from './components/bits';

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
  { id: 'sessions', label: 'Sessions' },
  { id: 'fleet',    label: 'Fleet' },
  { id: 'batches',  label: 'Batches' },
  { id: 'insights', label: 'Insights' },
  { id: 'skills',   label: 'Skills' },
  { id: 'plugins',  label: 'Plugins' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'context',  label: 'Context' },
  { id: 'settings', label: 'Settings' },
] as const;

type Tab = (typeof TABS)[number]['id'];

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
  // A session handing its changed files to a new batch run.
  const [batchSeed, setBatchSeed] = useState<{ projectId: string; root: string; paths: string[] } | null>(null);
  // Which session the keyboard-less surfaces (Skills) should talk to.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // The project the user last chose or last worked in, remembered per machine.
  const [picked, setPicked] = useState<string | null>(() => localStorage.getItem('foreman.project'));

  const tabRef = useRef<Tab>(tab); tabRef.current = tab;
  const sessionsRef = useRef<Session[]>(sessions); sessionsRef.current = sessions;

  const running = useMemo(() => sessions.filter((s) => s.status === 'running').length, [sessions]);

  const loadShell = useCallback(async () => {
    const [pv, pj, ks] = await Promise.all([
      window.foreman.providers.list(),
      window.foreman.projects.list(),
      window.foreman.key.status(),
    ]);
    setProviders(pv); setProjects(pj); setHasKey(ks.present);
  }, []);

  useEffect(() => { void loadShell(); }, [loadShell]);

  // ── motion setting ─────────────────────────────────────────────────
  // Published on the root element so CSS can answer without asking React.
  const loadMotion = useCallback(async () => {
    let m: MotionSetting = 'auto';
    try { m = (await window.foreman.prefs.all()).motion ?? 'auto'; } catch { /* db not ready */ }
    document.documentElement.dataset.motion = m;
  }, []);

  useEffect(() => { void loadMotion(); }, [loadMotion, tab]);

  useEffect(() => {
    const again = () => void loadMotion();
    window.addEventListener('focus', again);
    window.addEventListener('foreman:prefs-changed', again);
    return () => {
      window.removeEventListener('focus', again);
      window.removeEventListener('foreman:prefs-changed', again);
    };
  }, [loadMotion]);

  // ── nav counts ─────────────────────────────────────────────────────
  // Badges are polled centrally so a blocked agent or a running batch is
  // visible from whichever view you happen to be in. A failing endpoint zeroes
  // its own badge rather than blanking the others.
  const tick = useCallback(async () => {
    const [ss, runs, att] = await Promise.all([
      window.foreman.sessions.list().catch(() => [] as Session[]),
      window.foreman.batch.runs().catch(() => [] as { status: string }[]),
      window.foreman.attention.list().catch(() => [] as Attention[]),
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
    const offBatch = window.foreman.on.batchChanged(() => void tick());
    const offList = window.foreman.on.sessions((list) =>
      setSessions((prev) => (shape(prev) === shape(list) ? prev : list)));
    return () => { clearInterval(t); offBatch(); offList(); };
  }, [tick]);

  // Branches move constantly; keep the shared project list honest.
  useEffect(() => {
    const t = setInterval(() => {
      window.foreman.projects.refresh().then(setProjects).catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  // ── the shared selection ───────────────────────────────────────────
  // If the session we were pointing at is gone, fall back to the newest live
  // one rather than handing a dead id to Skills.
  useEffect(() => {
    setActiveSessionId((cur) => {
      if (cur && sessions.some((s) => s.id === cur)) return cur;
      const up = sessions.filter((s) => s.status === 'running');
      return (up[up.length - 1] ?? sessions[sessions.length - 1])?.id ?? null;
    });
  }, [sessions]);

  const choose = useCallback((id: string) => {
    setPicked(id);
    localStorage.setItem('foreman.project', id);
  }, []);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null, [sessions, activeSessionId]);

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

  const openSession = useCallback((id: string) => {
    setActiveSessionId(id);
    const s = sessionsRef.current.find((x) => x.id === id);
    if (s) choose(s.projectId);
    go('sessions');
    // Sessions owns its own tab selection; this is the request to focus one.
    window.dispatchEvent(new CustomEvent('foreman:open-session', { detail: { sessionId: id } }));
  }, [choose, go]);

  useEffect(() => {
    const onFocused = (e: Event) => {
      const id = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (id) setActiveSessionId(id);
    };
    window.addEventListener('foreman:session-focused', onFocused);
    return () => window.removeEventListener('foreman:session-focused', onFocused);
  }, []);

  // ⌘1–9. Capture phase, because Sessions binds ⌘1–9 to its own tabs and only
  // one of us can win; inside a terminal neither of us takes the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.length !== 1) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > TABS.length) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest('.terminal-host')) return;          // the PTY owns its keystrokes
      if (document.querySelector('.modal-backdrop')) return;  // a dialog owns the keyboard
      e.preventDefault();
      e.stopPropagation();
      go(TABS[n - 1].id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [go]);

  const addProject = useCallback(async () => {
    try {
      const p = await window.foreman.projects.pick();
      if (p) { setProjects(await window.foreman.projects.list()); choose(p.id); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [choose]);

  const removeProject = useCallback(async (id: string) => {
    setProjects(await window.foreman.projects.remove(id));
  }, []);

  // ── nav chrome ─────────────────────────────────────────────────────
  const tabsRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  const runBadge = useRef<HTMLSpanElement>(null);
  const needBadge = useRef<HTMLSpanElement>(null);
  const lastNeeds = useRef(0);

  // The underline is placed from measured geometry, so it can slide on the
  // compositor instead of the browser re-laying out a border every frame.
  useEffect(() => {
    const wrap = tabsRef.current, ink = inkRef.current;
    if (!wrap || !ink) return;
    const place = () => {
      const on = wrap.querySelector<HTMLElement>('.nav-tab.on');
      if (!on || !on.offsetWidth) { wrap.classList.remove('has-ink'); return; }
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
    const off = window.foreman.on.data(({ data }) => { bytes += data.length; });
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

  return (
    <div className="shell">
      <nav className="nav">
        <span className="brand">Foreman</span>
        <div className="nav-tabs" ref={tabsRef}>
          <NavTab id="sessions" n={1} tab={tab} go={go} label="Sessions">
            {running > 0 && (
              <span className="nav-badge mo-breathe" ref={runBadge}
                    title={`${running} session${running === 1 ? '' : 's'} running`}>{running}</span>
            )}
          </NavTab>
          <NavTab id="fleet" n={2} tab={tab} go={go} label="Fleet">
            {mark && (
              <span className={`nav-mark tone-${mark.tone}`} ref={needBadge}
                    title={`${needs.detail} — open Fleet (⌘2)`}>
                <span aria-hidden="true">{mark.glyph}</span>{needs.total} need you
              </span>
            )}
          </NavTab>
          <NavTab id="batches" n={3} tab={tab} go={go} label="Batches">
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
          <NavTab id="insights" n={4} tab={tab} go={go} label="Insights" />
          <NavTab id="skills"   n={5} tab={tab} go={go} label="Skills" />
          <NavTab id="plugins"  n={6} tab={tab} go={go} label="Plugins" />
          <NavTab id="schedules" n={7} tab={tab} go={go} label="Schedules" />
          <NavTab id="context"  n={8} tab={tab} go={go} label="Context" />
          <NavTab id="settings" n={9} tab={tab} go={go} label="Settings">
            {!hasKey && (
              <span className="nav-mark tone-warn" title="No API key set — add one in Settings before submitting a batch">
                <span aria-hidden="true">!</span>no key
              </span>
            )}
          </NavTab>
          <span className="nav-ink" ref={inkRef} aria-hidden="true" />
        </div>

        {tab === 'skills' && projects.length > 1 && (
          <label className="nav-project">
            <span className="label">Project</span>
            <select className="field" value={projectId ?? ''} onChange={(e) => choose(e.target.value)}
                    title="Which project's skills and settings to read">
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
      </nav>

      <div className="body">
        {tab === 'sessions' && (
          <Sessions providers={providers} projects={projects}
                    onAddProject={addProject} onError={setError}
                    onSendToBatch={(seed) => { setBatchSeed(seed); go('batches'); }} />
        )}
        {tab === 'fleet' && <Fleet projects={projects} onOpenSession={openSession} />}
        {tab === 'batches' && (
          <Batches projects={projects} hasKey={hasKey} onNeedKey={() => go('settings')}
                   seed={batchSeed} onSeedConsumed={() => setBatchSeed(null)} />
        )}
        {tab === 'insights' && <InsightsView />}
        {tab === 'skills' && <Skills projectId={projectId} activeSessionId={activeSessionId} />}
        {tab === 'plugins' && <Plugins />}
        {tab === 'schedules' && <Schedules projects={projects} />}
        {tab === 'context' && <Context projectId={projectId} projects={projects} />}
        {tab === 'settings' && (
          <SettingsView providers={providers} projects={projects}
                        onKeyChange={loadShell} onRemoveProject={removeProject} onAddProject={addProject} />
        )}
      </div>

      {error && (
        <div className="toast" onClick={() => setError(null)} role="alert">
          {error} <span className="faint">— click to dismiss</span>
        </div>
      )}
    </div>
  );
}

function NavTab({ id, n, tab, go, label, children }: {
  id: Tab; n: number; tab: Tab; go: (t: Tab) => void; label: string; children?: React.ReactNode;
}) {
  const on = tab === id;
  return (
    <button className={`nav-tab${on ? ' on' : ''}`} onClick={() => go(id)}
            aria-current={on ? 'page' : undefined} title={`${label} (⌘${n})`}>
      {label}
      {children}
    </button>
  );
}
