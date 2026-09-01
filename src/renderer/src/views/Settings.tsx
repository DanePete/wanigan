import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type {
  WaniganSettings, BackupCheck, BackupRestoreSummary, BackupSummary,
  EgressHost, LedgerEntry, McpServerConfig, MotionSetting, ThemeSetting,
  MobileMonitorConfig, MobileMonitorStatus, Project, ProviderInfo, QueueItem, QueueSlots, QueueState,
  TranscriptHit, TranscriptTurn, TrustLevel, UploadedFile, WorktreeInfo,
} from '@shared/types';
import { TRUST_COPY, TRUST_LEVELS } from '@shared/types';
import { Note, Section, Stat, ago, num } from '../components/bits';
import ThemeControl from '../components/ThemeControl';
import type { ResolvedTheme } from '../theme-boot';

type KeyStatus = { present: boolean; fingerprint: string | null; encryptionAvailable: boolean; fromEnv: boolean; workspaceId: string | null };
type ProviderKeyStatus = { present: boolean; fingerprint: string | null };
type SettingsTab = 'agents' | 'projects' | 'automation' | 'connections' | 'privacy' | 'backup' | 'app';

type SettingsTabInfo = {
  id: SettingsTab;
  label: string;
  eyebrow: string;
  title: string;
  detail: string;
  help: string;
  includes: string[];
};

const SETTINGS_TAB_STORAGE_KEY = 'wanigan.settings.tab';
// Keep the settings breakpoint deliberately wider than the general phone
// breakpoint. A 1,024 px iPad (or a desktop window in split view) has enough
// room for the content, but not enough room for a useful 212 px navigation
// rail beside forms, tables, and explanatory copy.
const SETTINGS_COMPACT_QUERY = '(max-width: 1024px), (pointer: coarse) and (max-width: 1180px)';

/**
 * Settings are organised by the job someone is trying to do, not by the table
 * that happened to hold the setting. A provider key, for example, belongs next
 * to the runtime that uses it; an MCP server belongs beside the remote device
 * that can observe the agent using it.
 */
const SETTINGS_TABS: SettingsTabInfo[] = [
  {
    id: 'agents', label: 'Agents', eyebrow: 'Accounts & runtime', title: 'Agents & providers',
    detail: 'Add provider keys, check their status, and see which local agent runtimes Wanigan can launch.',
    help: 'Keys are verified before Wanigan stores them in your macOS credential store. A new key is ready for the next session; a session already running keeps the launch configuration it started with.',
    includes: ['Claude Platform', 'GLM Coding Plan', 'DeepSeek', 'installed runtimes'],
  },
  {
    id: 'projects', label: 'Projects & safety', eyebrow: 'Repositories & guardrails', title: 'Projects & safety',
    detail: 'Manage repositories, clean up isolated worktrees, and set the policy record that accompanies agent tools.',
    help: 'Project and trust changes are saved as you make them. Trust is a visible policy and audit layer, not an operating-system sandbox; it never retroactively changes a command already running.',
    includes: ['projects', 'worktrees', 'trust levels', 'policy ledger'],
  },
  {
    id: 'automation', label: 'Automation', eyebrow: 'Cost & capacity', title: 'Automation',
    detail: 'Set a spend ceiling and decide how many interactive, headless, and batch jobs may run at once.',
    help: 'Save buttons apply the fields beside them. Lowering a limit prevents additional work from starting — queued for headless, batch and Scout work, refused outright for an interactive session — and deliberately does not stop work that is already underway.',
    includes: ['spending cap', 'concurrency limits', 'dispatch queue'],
  },
  {
    id: 'connections', label: 'Connections', eyebrow: 'Tools & remote access', title: 'Connections',
    detail: 'Configure MCP tool servers and the private iPad/phone monitor, alerts, and optional remote controls.',
    help: 'External connections are opt-in. Wanigan keeps local services on loopback and says when a setting needs a new session or an app restart before it can take effect.',
    includes: ['iPad & phone', 'Tailscale pairing', 'ntfy alerts', 'MCP servers'],
  },
  {
    id: 'privacy', label: 'Privacy & data', eyebrow: 'Observation & retention', title: 'Privacy & data',
    detail: 'Choose what Wanigan observes, search the transcript archive, inspect its own network boundaries, and remove locally retained data.',
    help: 'Most switches save immediately for future activity. The descriptions distinguish aggregate telemetry, tool summaries, and the separate transcript archive that can retain conversation text on this Mac.',
    includes: ['telemetry', 'transcript search', 'egress report', 'event retention'],
  },
  {
    id: 'backup', label: 'Backup', eyebrow: 'Copy & recovery', title: 'Backup & restore',
    detail: 'Write a verified copy of Wanigan’s database and transcript archive, check a copy you already have, and put one back.',
    help: 'A backup is a file operation you start here; nothing is scheduled and nothing is uploaded. Restoring replaces the database in place and relaunches Wanigan, so it refuses while any agent is still running.',
    includes: ['create a backup', 'verify a backup', 'restore', 'what is not copied'],
  },
  {
    id: 'app', label: 'App', eyebrow: 'Appearance & sharing', title: 'App experience',
    detail: 'Tune motion for comfort and prepare a safely masked view before sharing a screenshot or demo.',
    help: 'These are local presentation preferences. Motion changes immediately; demo mode reloads the app so every view starts from the same masked state.',
    includes: ['appearance', 'motion', 'demo mode', 'safe screenshots'],
  },
];

function savedSettingsTab(): SettingsTab {
  try {
    const saved = localStorage.getItem(SETTINGS_TAB_STORAGE_KEY);
    const match = SETTINGS_TABS.find((tab) => tab.id === saved);
    return match?.id ?? 'agents';
  } catch {
    return 'agents';
  }
}

function settingsTabInfo(id: SettingsTab): SettingsTabInfo {
  const tab = SETTINGS_TABS.find((entry) => entry.id === id);
  if (!tab) throw new Error(`Unknown settings tab: ${id}`);
  return tab;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/* ── formatting ──────────────────────────────────────────────────────── */

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function bytes(n: number): string {
  if (n < 1024) return `${num(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  // A backup of a year-old install is measured in gigabytes; capping the scale
  // at MB turned that into a five-digit number nobody reads as a size.
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

const fullDate = (ts: number) =>
  new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/** Durations carry both units, so "192" can never be mistaken for anything. */
function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const sep = (p: string) => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
const fileName = (p: string) => (sep(p) < 0 ? p : p.slice(sep(p) + 1));

/* ── marks: glyph + word + colour, in that order of importance ────────
   Green vs red measures ΔE 4.1 under deuteranopia, so no mark on this page
   ever leans on hue. The glyph and the word say it; colour only agrees. */

type MarkSpec = { glyph: string; word: string; color: string };

/* No `title` escape hatch. The reason behind a mark used to hide in a tooltip,
   which a touch screen has no gesture for and a keyboard cannot reach at all —
   so a reason worth giving is rendered beside the mark instead. */
function Mark({ glyph, word, color }: MarkSpec) {
  return (
    <span className="set-mark" style={{ color }}>
      <span className="g" aria-hidden="true">{glyph}</span>{word}
    </span>
  );
}

const ON: MarkSpec = { glyph: '✓', word: 'on', color: 'var(--good)' };
const OFF: MarkSpec = { glyph: '○', word: 'off', color: 'var(--text-faint)' };

const QUEUE_STATE: Record<QueueState, MarkSpec> = {
  waiting:  { glyph: '⋯', word: 'waiting',  color: 'var(--text-dim)' },
  running:  { glyph: '●', word: 'running',  color: 'var(--series-1)' },
  done:     { glyph: '✓', word: 'done',     color: 'var(--good)' },
  failed:   { glyph: '✕', word: 'failed',   color: 'var(--critical)' },
  canceled: { glyph: '⊖', word: 'canceled', color: 'var(--text-faint)' },
};

const DECISION: Record<LedgerEntry['decision'], MarkSpec> = {
  allow: { glyph: '✓', word: 'allowed', color: 'var(--good)' },
  ask:   { glyph: '?', word: 'asked',   color: 'var(--warning)' },
  deny:  { glyph: '⊘', word: 'denied',  color: 'var(--critical)' },
};

/**
 * Warnings use semantic roles rather than feature-specific colours. The global
 * palette now supplies both compact (--warn) and long-form (--warning) aliases
 * so Notes, status pills, and these load-bearing callouts stay coherent.
 */
function Callout({ level = 'warning', title, children }: {
  level?: 'warning' | 'critical'; title: React.ReactNode; children?: React.ReactNode;
}) {
  const m = level === 'critical'
    ? { bg: 'var(--critical-soft)', fg: 'var(--critical)', glyph: '✕' }
    : { bg: 'var(--warning-soft)', fg: 'var(--warning)', glyph: '⚠' };
  return (
    <div style={{ background: m.bg, borderLeft: `3px solid ${m.fg}`, borderRadius: 'var(--r-sm)',
                  padding: '10px 13px', display: 'flex', gap: 9 }}>
      <span aria-hidden="true" style={{ color: m.fg, fontWeight: 700, lineHeight: 1.4 }}>{m.glyph}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: m.fg, fontWeight: 650, fontSize: 'var(--t-small)', lineHeight: 1.45 }}>{title}</div>
        {children ? <div className="dim" style={{ fontSize: 'var(--t-small)', lineHeight: 1.55, marginTop: 5 }}>{children}</div> : null}
      </div>
    </div>
  );
}

/* ── loading ─────────────────────────────────────────────────────────── */

type Load<T> = { s: 'loading' } | { s: 'ok'; d: T } | { s: 'err'; e: string };

/**
 * Loading, error and data are three states with three renderings; empty and
 * zero-results are decided by the caller, because only it knows the difference
 * between "nothing exists" and "your filter excluded everything".
 */
function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []): { v: Load<T>; reload: () => void } {
  const [v, setV] = useState<Load<T>>({ s: 'loading' });
  const [tick, setTick] = useState(0);
  const fn = useRef(load);
  fn.current = load;

  useEffect(() => {
    let live = true;
    fn.current()
      .then((d) => { if (live) setV({ s: 'ok', d }); })
      .catch((e) => { if (live) setV({ s: 'err', e: msg(e) }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  return { v, reload: useCallback(() => setTick((t) => t + 1), []) };
}

function PanelError({ what, detail, onRetry }: { what: string; detail: string; onRetry: () => void }) {
  return (
    <Callout level="critical" title={`Wanigan could not read ${what}.`}>
      <p className="mono" style={{ fontSize: 'var(--t-small)', wordBreak: 'break-word' }}>{detail}</p>
      <p style={{ marginTop: 6 }}>
        If the message names a missing handler, the main process has not registered that channel and
        nothing on this panel will work until it does. Otherwise the read was transient: try again,
        and if it repeats, restart Wanigan.
      </p>
      <button className="btn" style={{ marginTop: 8 }} onClick={onRetry}>Try again</button>
    </Callout>
  );
}

function Frame<T>({ v, what, onRetry, children }: {
  v: Load<T>; what: string; onRetry: () => void; children: (d: T) => React.ReactNode;
}) {
  if (v.s === 'loading') return <p className="dim" style={{ fontSize: 'var(--t-small)', padding: '6px 2px' }}>Reading {what}…</p>;
  if (v.s === 'err') return <PanelError what={what} detail={v.e} onRetry={onRetry} />;
  return <>{children(v.d)}</>;
}

/* ── controls ────────────────────────────────────────────────────────── */

function Toggle({ on, title, busy, onChange, children }: {
  on: boolean; title: string; busy?: boolean; onChange: (next: boolean) => void; children: React.ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="txt">
        <h4>{title}</h4>
        <p>{children}</p>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={title}
              className="set-switch" disabled={busy} onClick={() => onChange(!on)}>
        <span className="set-state" style={{ color: on ? 'var(--good)' : 'var(--text-faint)' }}>
          <span aria-hidden="true">{on ? '✓' : '○'}</span> {on ? 'On' : 'Off'}
        </span>
        <span className="set-track"><span className="set-knob" /></span>
      </button>
    </div>
  );
}

function Options<T extends string>({ label, value, options, onPick }: {
  label: string; value: T; options: { id: T; word: string; detail: string }[]; onPick: (v: T) => void;
}) {
  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = options.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = last;
    if (next === null) return;
    event.preventDefault();
    const group = event.currentTarget.parentElement;
    onPick(options[next].id);
    requestAnimationFrame(() => {
      const choices = group?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      choices?.[next]?.focus({ preventScroll: true });
    });
  }

  return (
    <div role="radiogroup" aria-label={label} className="set-opts">
      {options.map((o, index) => {
        const on = o.id === value;
        return (
          <button key={o.id} type="button" role="radio" aria-checked={on}
                  tabIndex={on ? 0 : -1} className={`set-opt${on ? ' on' : ''}`}
                  onClick={() => onPick(o.id)} onKeyDown={(event) => move(event, index)}>
            <span className="set-opt-top">
              <span className="g" aria-hidden="true">{on ? '●' : '○'}</span>
              {o.word}
              {on && <span className="set-opt-now">current</span>}
            </span>
            <span className="set-opt-detail">{o.detail}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A saved/failed line that says what happened, not that something happened. */
function Result({ r }: { r: { tone: 'ok' | 'error'; text: string } | null }) {
  if (!r) return null;
  if (r.tone === 'error') return <div style={{ marginTop: 10 }}><Callout level="critical" title={r.text} /></div>;
  return <div style={{ marginTop: 10 }}><Note tone="ok">{r.text}</Note></div>;
}

/** One persistent panel per tab: changing category must never discard a draft. */
function SettingsTabPanel({ tab, active, children }: {
  tab: SettingsTabInfo; active: boolean; children: React.ReactNode;
}) {
  return (
    <div id={`settings-${tab.id}`} className="set-tab-panel" role="tabpanel"
         aria-labelledby={`settings-tab-${tab.id}`} hidden={!active}>
      <header className="set-panel-intro">
        <div className="set-panel-kicker">{tab.eyebrow}</div>
        <h2>{tab.title}</h2>
        <p>{tab.detail}</p>
        <div className="set-panel-help">
          <span className="set-panel-help-mark" aria-hidden="true">?</span>
          <div><strong>How changes apply</strong><p>{tab.help}</p></div>
        </div>
        <p className="set-panel-includes">
          <strong>In this section</strong><span>{tab.includes.join(' · ')}</span>
        </p>
      </header>
      {children}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   The page
   ════════════════════════════════════════════════════════════════════════ */

export default function Settings({
  providers, projects, onKeyChange, onRemoveProject, onAddProject,
  themePreference, resolvedTheme, onThemeChange,
}: {
  providers: ProviderInfo[];
  projects: Project[];
  onKeyChange: () => void;
  onRemoveProject: (id: string) => void;
  onAddProject: () => void;
  themePreference: ThemeSetting;
  resolvedTheme: ResolvedTheme;
  onThemeChange: (preference: ThemeSetting) => Promise<ThemeSetting>;
}) {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [input, setInput] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msgState, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [cap, setCap] = useState('1.00');
  const [glmKey, setGlmKey] = useState('');
  const [glmStatus, setGlmStatus] = useState<ProviderKeyStatus | null>(null);
  const [glmBusy, setGlmBusy] = useState(false);
  const [glmMsg, setGlmMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [deepseekKey, setDeepseekKey] = useState('');
  const [deepseekStatus, setDeepseekStatus] = useState<ProviderKeyStatus | null>(null);
  const [deepseekBusy, setDeepseekBusy] = useState(false);
  const [deepseekMsg, setDeepseekMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(savedSettingsTab);
  const compactSettingsLayout = useMediaQuery(SETTINGS_COMPACT_QUERY);
  const settingsTabsRef = useRef<HTMLElement>(null);

  const load = () => window.wanigan.key.status().then((st) => {
    setStatus(st);
    if (st.workspaceId) { setWorkspaceId(st.workspaceId); setShowWorkspace(true); }
  });
  useEffect(() => {
    void load();
    void window.wanigan.key.provider('glm').then(setGlmStatus).catch(() => {});
    void window.wanigan.key.provider('deepseek').then(setDeepseekStatus).catch(() => {});
    window.wanigan.settings.get().then((s) => setCap(s.spendCapUsd.toFixed(2))).catch(() => {});
  }, []);

  const loadGlm = () => window.wanigan.key.provider('glm').then(setGlmStatus);
  async function saveGlm() {
    setGlmBusy(true); setGlmMsg(null);
    try {
      await window.wanigan.key.setProvider('glm', glmKey);
      const verified = await window.wanigan.key.glmVerify();
      setGlmKey(''); await loadGlm(); onKeyChange();
      setGlmMsg({ tone: verified.ok ? 'ok' : 'error', text: verified.detail });
    } catch (e) { setGlmMsg({ tone: 'error', text: msg(e) }); }
    finally { setGlmBusy(false); }
  }
  async function verifyGlm() {
    setGlmBusy(true); setGlmMsg(null);
    try {
      const verified = await window.wanigan.key.glmVerify();
      setGlmMsg({ tone: verified.ok ? 'ok' : 'error', text: verified.detail });
    } catch (e) { setGlmMsg({ tone: 'error', text: msg(e) }); }
    finally { setGlmBusy(false); }
  }
  async function clearGlm() {
    setGlmBusy(true);
    try { await window.wanigan.key.clearProvider('glm'); await loadGlm(); onKeyChange(); setGlmMsg(null); }
    finally { setGlmBusy(false); }
  }

  const loadDeepseek = () => window.wanigan.key.provider('deepseek').then(setDeepseekStatus);
  async function saveDeepseek() {
    setDeepseekBusy(true); setDeepseekMsg(null);
    try {
      await window.wanigan.key.setProvider('deepseek', deepseekKey);
      const verified = await window.wanigan.key.deepseekVerify();
      setDeepseekKey(''); await loadDeepseek(); onKeyChange();
      setDeepseekMsg({ tone: verified.ok ? 'ok' : 'error', text: verified.detail });
    } catch (e) { setDeepseekMsg({ tone: 'error', text: msg(e) }); }
    finally { setDeepseekBusy(false); }
  }
  async function verifyDeepseek() {
    setDeepseekBusy(true); setDeepseekMsg(null);
    try {
      const verified = await window.wanigan.key.deepseekVerify();
      setDeepseekMsg({ tone: verified.ok ? 'ok' : 'error', text: verified.detail });
    } catch (e) { setDeepseekMsg({ tone: 'error', text: msg(e) }); }
    finally { setDeepseekBusy(false); }
  }
  async function clearDeepseek() {
    setDeepseekBusy(true);
    try { await window.wanigan.key.clearProvider('deepseek'); await loadDeepseek(); onKeyChange(); setDeepseekMsg(null); }
    finally { setDeepseekBusy(false); }
  }

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await window.wanigan.key.set(input.trim(), workspaceId.trim() || undefined);
      setInput('');
      setMsg({ tone: 'ok', text: `${r.detail}${r.batches ? ' · Batches API reachable.' : ' · Batches API NOT reachable for this workspace.'}` });
      await load(); onKeyChange();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      // Identity-linked keys need the workspace named; reveal the field rather
      // than making the user find a setting they have not been shown.
      if (text.includes('identity-linked') || text.includes('workspace')) setShowWorkspace(true);
      setMsg({ tone: 'error', text });
    } finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true); setMsg(null);
    const r = await window.wanigan.key.verify();
    setMsg({ tone: r.ok ? 'ok' : 'error', text: r.detail + (r.ok && !r.batches ? ' · Batches API NOT reachable.' : '') });
    setBusy(false);
  }

  async function clear() {
    await window.wanigan.key.clear();
    setMsg(null); await load(); onKeyChange();
  }

  /* ── shared preferences ────────────────────────────────────────────── */

  const [prefs, setPrefs] = useState<WaniganSettings | null>(null);
  const [prefsErr, setPrefsErr] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const loadPrefs = useCallback(() => {
    window.wanigan.prefs.all()
      .then((p) => { setPrefs(p); setPrefsErr(null); })
      .catch((e) => setPrefsErr(msg(e)));
  }, []);
  useEffect(() => { loadPrefs(); }, [loadPrefs]);

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, settingsTab); } catch { /* storage may be disabled */ }
  }, [settingsTab]);

  // A remembered tab can begin off-screen in the horizontal iPad strip. Keep
  // its control visible without calling scrollIntoView(), which can also move
  // the settings document and make a category change feel like a page jump.
  useEffect(() => {
    if (!compactSettingsLayout) return;
    const frame = requestAnimationFrame(() => {
      const strip = settingsTabsRef.current;
      const control = document.getElementById(`settings-tab-${settingsTab}`);
      if (!strip || !control) return;
      const stripBox = strip.getBoundingClientRect();
      const controlBox = control.getBoundingClientRect();
      const inset = 8;
      if (controlBox.left < stripBox.left + inset) {
        strip.scrollLeft -= stripBox.left + inset - controlBox.left;
      } else if (controlBox.right > stripBox.right - inset) {
        strip.scrollLeft += controlBox.right - (stripBox.right - inset);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [compactSettingsLayout, settingsTab]);

  const setPref = useCallback(async (k: string, v: string) => {
    setPending(k); setPrefsErr(null);
    try {
      setPrefs(await window.wanigan.prefs.set(k, v));
      // App and the pet both read prefs on this event. Nothing dispatched it
      // before, so App's listener had never once fired.
      window.dispatchEvent(new CustomEvent('wanigan:prefs-changed'));
    } catch (e) {
      setPrefsErr(`“${k}” was not saved: ${msg(e)} — the value on screen is the one you typed, not the one on disk.`);
    } finally { setPending(null); }
  }, []);

  const setFlag = useCallback(async (k: string, on: boolean) => {
    // notify keeps its own in-process copy of this flag; writing the setting
    // alone would leave the running poller using the previous answer.
    if (k === 'notifications') await window.wanigan.notify.setEnabled(on).catch(() => {});
    await setPref(k, on ? '1' : '0');
  }, [setPref]);

  function chooseSettingsTab(next: SettingsTab, moveFocus = false) {
    setSettingsTab(next);
    if (!moveFocus) return;
    // Roving focus keeps the compact tab row usable with a hardware keyboard
    // on iPad as well as assistive technology on desktop. Scroll only the tab
    // strip; switching sections must not throw the document to the top.
    requestAnimationFrame(() => {
      const control = document.getElementById(`settings-tab-${next}`);
      control?.focus({ preventScroll: true });
      control?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function moveSettingsTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = SETTINGS_TABS.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = last;
    if (next === null) return;
    event.preventDefault();
    chooseSettingsTab(SETTINGS_TABS[next].id, true);
  }

  return (
    <div className="pane set" data-motion={prefs?.motion ?? 'auto'}>
      <style>{SHEET}</style>

      <header className="set-hero">
        <div>
          <div className="set-kicker">Wanigan control center</div>
          <h1>Settings</h1>
          <p>Everything is grouped by the job you are trying to do, so provider setup, remote access, and safety controls stay easy to find.</p>
        </div>
        <aside className="set-save-guide" aria-label="How settings are saved">
          <strong>How settings work</strong>
          <span>Most switches save immediately. A button labelled Save applies the fields beside it. Each section calls out anything that waits for a new session or restart.</span>
        </aside>
      </header>

      {prefsErr && <Callout level="critical" title="A preference did not save.">{prefsErr}</Callout>}

      <div className="set-layout">
        <nav ref={settingsTabsRef} className="set-tabs" role="tablist" aria-label="Settings sections"
             aria-orientation={compactSettingsLayout ? 'horizontal' : 'vertical'}>
          <div className="set-tabs-intro">
            <strong>Settings areas</strong>
            <span>Choose a category. Your unfinished form entries stay here while you move between tabs.</span>
          </div>
          {SETTINGS_TABS.map((tab, index) => (
            <button id={`settings-tab-${tab.id}`} key={tab.id} type="button" role="tab"
                    aria-selected={settingsTab === tab.id} tabIndex={settingsTab === tab.id ? 0 : -1}
                    aria-controls={`settings-${tab.id}`} className={settingsTab === tab.id ? 'on' : ''}
                    onClick={() => chooseSettingsTab(tab.id)} onKeyDown={(event) => moveSettingsTab(event, index)}>
              <span className="set-tab-label">{tab.label}</span>
              <span className="set-tab-detail">{tab.eyebrow}</span>
            </button>
          ))}
        </nav>

        <div className="set-panels">
          <SettingsTabPanel tab={settingsTabInfo('agents')} active={settingsTab === 'agents'}>
            <Section title="Claude Platform API key"
                     hint="Needed for Batches — estimating, dry runs, and submitting. Agent sessions do not use it; they authenticate through their own CLI.">
              {status?.fromEnv && (
                <div style={{ marginBottom: 11 }}>
                  <Note tone="info">
                    <code className="mono">ANTHROPIC_API_KEY</code> is set in the environment and takes precedence
                    over anything stored here.
                  </Note>
                </div>
              )}

              {status?.present ? (
                <div className="set-key-status">
                  <span className="pill" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>key installed</span>
                  <span className="mono faint">{status.fingerprint}</span>
                  {status.workspaceId && (
                    <span className="pill mono" style={{ background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}
                          title="anthropic-workspace-id sent on every request">{status.workspaceId}</span>
                  )}
                  <button className="btn" onClick={verify} disabled={busy}>Verify</button>
                  <button className="btn btn-danger" onClick={clear} disabled={busy}>Remove</button>
                </div>
              ) : (
                <div style={{ marginBottom: 11 }}>
                  <Note tone="warn">No key stored. Batches cannot estimate or submit without one.</Note>
                </div>
              )}

              <label className="label" htmlFor="anthropic-api-key">{status?.present ? 'Replace key' : 'Paste your key'}</label>
              <div className="set-field-action">
                <input id="anthropic-api-key" className="field mono" type="password" placeholder="sk-ant-api03-…" value={input}
                       autoComplete="off" spellCheck={false}
                       onChange={(e) => setInput(e.target.value)}
                       onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) void save(); }} />
                <button className="btn btn-primary" onClick={save} disabled={busy || !input.trim()}>
                  {busy ? 'Verifying…' : 'Save'}
                </button>
              </div>

              {showWorkspace ? (
                <div style={{ marginTop: 11 }}>
                  <label className="label" htmlFor="anthropic-workspace-id">
                    Workspace ID
                    <span className="faint" style={{ textTransform: 'none' }}> — required for identity-linked keys</span>
                  </label>
                  <input id="anthropic-workspace-id" className="field mono" style={{ marginTop: 4 }} placeholder="wrkspc_…"
                         value={workspaceId} spellCheck={false}
                         onChange={(e) => setWorkspaceId(e.target.value)}
                         onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) void save(); }} />
                  <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 4, lineHeight: 1.45 }}>
                    Console → Settings → Workspaces. Sent as the{' '}
                    <span className="mono">anthropic-workspace-id</span> header on every request.
                    Plain API keys ignore it, so leaving it set is harmless.
                  </p>
                </div>
              ) : (
                <button className="faint" style={{ fontSize: 'var(--t-small)', marginTop: 8 }}
                        onClick={() => setShowWorkspace(true)}>
                  + add a Workspace ID (needed for identity-linked keys)
                </button>
              )}

              {msgState && <div style={{ marginTop: 11 }}><Note tone={msgState.tone === 'ok' ? 'ok' : 'error'}>{msgState.text}</Note></div>}

              <div className="sunk" style={{ padding: '10px 12px', marginTop: 14, fontSize: 'var(--t-small)', lineHeight: 1.55 }}>
                <p>
                  <strong>This is not your Claude Code subscription.</strong> The Batches API bills per token
                  against a Claude Platform account with its own credit balance. Get a key at{' '}
                  <button className="link" onClick={() => window.open('https://console.anthropic.com/settings/keys')}>
                    console.anthropic.com/settings/keys
                  </button>. A Claude Code OAuth token is rejected.
                </p>
                <p className="dim" style={{ marginTop: 8 }}>
                  The key is verified against the live API before it is saved, then encrypted with{' '}
                  {status?.encryptionAvailable ? 'your macOS Keychain' : 'the OS credential store'} — it is never
                  written to a plaintext file, never logged, and never sent to the renderer.
                </p>
                <p className="dim" style={{ marginTop: 8 }}>
                  <strong>Identity-linked keys need a Workspace ID.</strong> If your organisation issues keys
                  tied to an identity, the API returns a 400 until every request names the workspace it acts in.
                  Wanigan sends it as the <span className="mono">anthropic-workspace-id</span> header.
                  <br /><br />
                  <strong>Workload identity federation is a different thing</strong> and does not apply here: it
                  exchanges a short-lived JWT from a cloud or CI identity provider, so it only works on GCP, AWS,
                  Azure or GitHub Actions. A local desktop app has nothing to federate from.
                </p>
              </div>
            </Section>

            <Section title="GLM Coding Plan"
                     hint="Runs GLM through the installed Claude Code runtime, with the Z.ai Coding Plan endpoint and Wanigan’s normal sessions, attachments, code review, worktrees, MCP configuration and headless runs.">
              {glmStatus?.present ? (
                <div className="set-key-status">
                  <span className="pill" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>Coding Plan key installed</span>
                  <span className="mono faint">{glmStatus.fingerprint}</span>
                  <button className="btn" onClick={() => void verifyGlm()} disabled={glmBusy}>Verify live catalogue</button>
                  <button className="btn btn-danger" onClick={() => void clearGlm()} disabled={glmBusy}>Remove</button>
                </div>
              ) : <Note tone="warn">No Z.ai Coding Plan key stored. GLM sessions cannot authenticate until you add one.</Note>}
              <label className="label" htmlFor="glm-api-key" style={{ marginTop: 11 }}>{glmStatus?.present ? 'Replace Z.ai key' : 'Paste Z.ai Coding Plan API key'}</label>
              <div className="set-field-action">
                <input id="glm-api-key" className="field mono" type="password" placeholder="Z.ai API key" value={glmKey} autoComplete="off" spellCheck={false}
                       onChange={(e) => setGlmKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && glmKey.trim()) void saveGlm(); }} />
                <button className="btn btn-primary" onClick={() => void saveGlm()} disabled={glmBusy || !glmKey.trim()}>{glmBusy ? 'Checking…' : 'Save & verify'}</button>
              </div>
              {glmMsg && <div style={{ marginTop: 10 }}><Note tone={glmMsg.tone === 'ok' ? 'ok' : 'error'}>{glmMsg.text}</Note></div>}
              <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 8, lineHeight: 1.45 }}>
                The key is verified against <span className="mono">api.z.ai/api/coding/paas/v4/models</span> before Wanigan saves it, then encrypted in your macOS Keychain. Wanigan does not show or log the key.
              </p>
            </Section>

            <Section title="DeepSeek"
                     hint="Runs DeepSeek through the installed Claude Code runtime using DeepSeek’s Anthropic-compatible endpoint. It gets the same Wanigan terminal, review, policy, worktree and headless-run controls as Claude and GLM.">
              {deepseekStatus?.present ? (
                <div className="set-key-status">
                  <span className="pill" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>DeepSeek key installed</span>
                  <span className="mono faint">{deepseekStatus.fingerprint}</span>
                  <button className="btn" onClick={() => void verifyDeepseek()} disabled={deepseekBusy}>Verify live catalogue</button>
                  <button className="btn btn-danger" onClick={() => void clearDeepseek()} disabled={deepseekBusy}>Remove</button>
                </div>
              ) : <Note tone="warn">No DeepSeek key stored. DeepSeek sessions cannot authenticate until you add one.</Note>}
              <label className="label" htmlFor="deepseek-api-key" style={{ marginTop: 11 }}>{deepseekStatus?.present ? 'Replace DeepSeek key' : 'Paste DeepSeek API key'}</label>
              <div className="set-field-action">
                <input id="deepseek-api-key" className="field mono" type="password" placeholder="DeepSeek API key" value={deepseekKey} autoComplete="off" spellCheck={false}
                       onChange={(e) => setDeepseekKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && deepseekKey.trim()) void saveDeepseek(); }} />
                <button className="btn btn-primary" onClick={() => void saveDeepseek()} disabled={deepseekBusy || !deepseekKey.trim()}>{deepseekBusy ? 'Checking…' : 'Save & verify'}</button>
              </div>
              {deepseekMsg && <div style={{ marginTop: 10 }}><Note tone={deepseekMsg.tone === 'ok' ? 'ok' : 'error'}>{deepseekMsg.text}</Note></div>}
              <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 8, lineHeight: 1.45 }}>
                Wanigan verifies the key against <span className="mono">api.deepseek.com/models</span>, then stores it encrypted in your macOS Keychain. The key is never shown, logged or sent to a renderer.
              </p>
            </Section>

            <Section title="Installed agent runtimes" hint="Resolved from your login shell's PATH, then from editor extension directories.">
              {providers.map((p) => (
                <div className="set-runtime-row" key={p.id}>
                  <span style={{ fontWeight: 600, minWidth: 110 }}>{p.label}</span>
                  {p.path ? (
                    <>
                      <span className="pill" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>{p.version ?? 'installed'}</span>
                      <span className="faint set-path set-wrap" style={{ flex: 1 }}>{p.path}</span>
                    </>
                  ) : (
                    <span className="faint">not found — <code className="mono">{p.bin}</code> is not on PATH or in an editor extension</span>
                  )}
                </div>
              ))}
            </Section>
          </SettingsTabPanel>

          <SettingsTabPanel tab={settingsTabInfo('projects')} active={settingsTab === 'projects'}>
            <Projects projects={projects} onAddProject={onAddProject} onRemoveProject={onRemoveProject} />
            <Worktrees />
            <Trust projects={projects} onAddProject={onAddProject} />
          </SettingsTabPanel>

          <SettingsTabPanel tab={settingsTabInfo('automation')} active={settingsTab === 'automation'}>
            <Section title="Spending"
                     hint="A batch cannot be un-submitted. The cap is checked against the estimate at submit time — the last moment anything is preventable.">
              <label className="label" htmlFor="spend-cap">Maximum estimated cost per run (USD)</label>
              <div className="set-field-action" style={{ maxWidth: 320 }}>
                <input id="spend-cap" className="field mono" type="number" min={0} step="0.25" value={cap}
                       onChange={(e) => setCap(e.target.value)} />
                <button className="btn" onClick={async () => {
                  const v = await window.wanigan.settings.setSpendCap(Number(cap) || 0);
                  setCap(v.toFixed(2));
                  setMsg({ tone: 'ok', text: v > 0 ? `Runs estimated above $${v.toFixed(2)} will be blocked.` : 'Spend cap disabled.' });
                }}>Save</button>
              </div>
              <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 5, lineHeight: 1.45 }}>
                0 disables the cap. The estimate is a low-end figure that assumes caching engages, so
                leave headroom — the builder shows the upper bound beside it.
              </p>
              {msgState && <div style={{ marginTop: 11 }}><Note tone={msgState.tone === 'ok' ? 'ok' : 'error'}>{msgState.text}</Note></div>}
            </Section>
            <Dispatcher active={settingsTab === 'automation'} />
          </SettingsTabPanel>

          <SettingsTabPanel tab={settingsTabInfo('connections')} active={settingsTab === 'connections'}>
            <PhoneMonitor />
            <Mcp projects={projects} prefs={prefs} pending={pending} setFlag={setFlag} />
          </SettingsTabPanel>

          <SettingsTabPanel tab={settingsTabInfo('privacy')} active={settingsTab === 'privacy'}>
            <Observation prefs={prefs} pending={pending} setFlag={setFlag} />
            <TranscriptSearch prefs={prefs} />
            <Egress />
            <Storage prefs={prefs} pending={pending} setPref={setPref} />
          </SettingsTabPanel>

          <SettingsTabPanel tab={settingsTabInfo('backup')} active={settingsTab === 'backup'}>
            <Backup />
          </SettingsTabPanel>

          <SettingsTabPanel tab={settingsTabInfo('app')} active={settingsTab === 'app'}>
            <Appearance preference={themePreference} resolved={resolvedTheme} onChange={onThemeChange} />
            <Motion prefs={prefs} pending={pending} setPref={setPref} />
            <DemoPanel />
          </SettingsTabPanel>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Projects, and what removing one destroys
   ════════════════════════════════════════════════════════════════════════ */

/**
 * What a removal actually takes with it, counted from the record.
 *
 * `projects.remove` is one DELETE, but `work_dockets.project_id` is
 * ON DELETE CASCADE, so the row takes every Goal for that project and, through
 * them, the nodes, claims, checkpoints, proofs, trace events, resume receipts
 * and model outcomes underneath. store.ts already reasoned this through on the
 * automatic path and refused there — a project whose directory is merely
 * unmounted is hidden, never deleted. The manual path is the one that still
 * needs to say what it is about to spend, and to say it with counts rather
 * than with the word "permanently".
 */
type RemovalCost = {
  goals: number;
  /** True when the Goal list came back at its ceiling, so `goals` is a floor. */
  goalsCapped: boolean;
  nodes: number;
  proofs: number;
  checkpoints: number;
  claims: number;
  sessions: number;
  /** How many Goals could not be opened, so a zero is never printed as a fact. */
  unread: number;
};

/** The ceiling `control.list` enforces; asking for more returns no more. */
const GOAL_COUNT_CEILING = 200;

async function readRemovalCost(projectId: string): Promise<RemovalCost> {
  const [goals, past] = await Promise.all([
    window.wanigan.control.list(projectId, GOAL_COUNT_CEILING),
    window.wanigan.sessions.past(),
  ]);
  // One read per Goal, because only the detail carries the child rows the
  // cascade reaches. Bounded by the ceiling above, so this cannot fan out.
  const details = await Promise.all(
    goals.map((g) => window.wanigan.control.get(g.id).catch(() => null)),
  );

  const cost: RemovalCost = {
    goals: goals.length, goalsCapped: goals.length >= GOAL_COUNT_CEILING,
    nodes: 0, proofs: 0, checkpoints: 0, claims: 0,
    sessions: past.filter((s) => s.projectId === projectId).length,
    unread: 0,
  };
  for (const d of details) {
    if (!d) { cost.unread += 1; continue; }
    cost.nodes += d.nodes.length;
    cost.proofs += d.proofs.length;
    cost.checkpoints += d.checkpoints.length;
    cost.claims += d.claims.length;
  }
  return cost;
}

/**
 * The confirmation itself.
 *
 * Typing the name is asked for only when there is recorded work to lose. A
 * project registered an hour ago with nothing under it does not need a
 * ceremony; one carrying forty proofs does, because nothing in the app can
 * bring those back.
 */
function RemoveProjectConfirm({ project, onCancel, onConfirm }: {
  project: Project; onCancel: () => void; onConfirm: () => void;
}) {
  const cost = useLoad(() => readRemovalCost(project.id), [project.id]);
  const [typed, setTyped] = useState('');

  return (
    <div className="set-danger-zone" role="group" aria-label={`Confirm removing ${project.name}`}>
      <Callout level="critical" title={`Remove “${project.name}” and everything recorded against it?`}>
        Removing a project is not the same as closing it. Wanigan deletes the project row, and the
        database cascades from there through its Goals into every node, claim, checkpoint, proof,
        trace event, resume receipt and model outcome underneath. <strong>There is no undo, and no
        backup is taken first.</strong> The repository on disk is untouched — only Wanigan’s record
        of the work goes.
      </Callout>

      <Frame v={cost.v} what={`what removing ${project.name} would destroy`} onRetry={cost.reload}>
        {(c) => {
          const evidence = c.goals + c.nodes + c.proofs + c.checkpoints + c.claims;
          const gate = evidence > 0;
          const ready = !gate || typed.trim() === project.name;
          return (
            <>
              <div className="set-scroll">
                <table className="grid">
                  <thead><tr><th>What goes</th><th className="r">Count</th><th>What survives</th></tr></thead>
                  <tbody>
                    <tr>
                      <td>Goals for this project</td>
                      <td className="set-n">{c.goalsCapped ? `${num(c.goals)}+` : num(c.goals)}</td>
                      <td className="dim">Nothing — the Goal row is the parent of the cascade.</td>
                    </tr>
                    <tr>
                      <td>Nodes under those Goals</td>
                      <td className="set-n">{num(c.nodes)}</td>
                      <td className="dim">Nothing.</td>
                    </tr>
                    <tr>
                      <td>Proofs recorded against them</td>
                      <td className="set-n">{num(c.proofs)}</td>
                      <td className="dim">Nothing. A proof is a recorded run; it cannot be re-derived.</td>
                    </tr>
                    <tr>
                      <td>Checkpoints and file claims</td>
                      <td className="set-n">{num(c.checkpoints + c.claims)}</td>
                      <td className="dim">Nothing.</td>
                    </tr>
                    <tr>
                      <td>Past sessions filed under it</td>
                      <td className="set-n">{num(c.sessions)}</td>
                      <td className="dim">
                        The session rows stay; they lose the project they pointed at. Archived
                        transcripts are removed separately, in Privacy &amp; data.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {c.goalsCapped && (
                <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.5 }}>
                  The Goal list is read at a ceiling of {num(GOAL_COUNT_CEILING)}, so the counts above
                  are a floor, not a total. There is at least this much.
                </p>
              )}
              {c.unread > 0 && (
                <div style={{ marginTop: 9 }}>
                  <Note tone="warn">
                    {plural(c.unread, 'Goal')} could not be opened, so the node, proof and checkpoint
                    counts above exclude {c.unread === 1 ? 'it' : 'them'}. The real number is higher.
                  </Note>
                </div>
              )}

              {gate ? (
                <div style={{ marginTop: 12, maxWidth: 380 }}>
                  <label className="label" htmlFor={`confirm-remove-${project.id}`}>
                    Type the project name to confirm
                  </label>
                  <input id={`confirm-remove-${project.id}`} className="field mono" style={{ marginTop: 4 }}
                         value={typed} spellCheck={false} autoComplete="off" placeholder={project.name}
                         onChange={(e) => setTyped(e.target.value)} />
                  <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 4, lineHeight: 1.45 }}>
                    Asked for because there is recorded work here. A project with nothing under it is
                    removed on one click.
                  </p>
                </div>
              ) : (
                <p className="dim" style={{ fontSize: 'var(--t-small)', marginTop: 10, lineHeight: 1.5 }}>
                  Nothing is recorded against this project yet, so removing it destroys no evidence.
                </p>
              )}

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
                <button className="btn btn-danger" disabled={!ready} onClick={onConfirm}>
                  Remove {project.name} permanently
                </button>
                <button className="btn" onClick={onCancel}>Keep it</button>
              </div>
            </>
          );
        }}
      </Frame>
    </div>
  );
}

function Projects({ projects, onAddProject, onRemoveProject }: {
  projects: Project[]; onAddProject: () => void; onRemoveProject: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const target = projects.find((p) => p.id === confirming) ?? null;

  return (
    <Section title="Projects" hint="Shared by both views — an agent session and a batch run target the same repo."
             right={<button className="btn" onClick={onAddProject}>+ Add project</button>}>
      {!projects.length && <p className="dim">No projects yet.</p>}
      {projects.map((p) => (
        <Fragment key={p.id}>
          <div className="set-project-row">
            <span style={{ fontWeight: 500 }}>{p.name}</span>
            {p.branch && <span className="pill mono" style={{ background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>{p.branch}</span>}
            {/* The path used to be a tooltip on a truncated line, which is
                nothing at all on a touch screen. It wraps instead. */}
            <span className="faint set-path set-wrap" style={{ flex: 1 }}>{p.path}</span>
            <button className="set-mini danger" aria-expanded={confirming === p.id}
                    onClick={() => { setSaved(null); setConfirming(confirming === p.id ? null : p.id); }}>
              {confirming === p.id ? 'cancel' : 'remove…'}
            </button>
          </div>
          {/* Directly under the row it belongs to: a confirmation that appears
              somewhere else on the page is a confirmation of nothing in
              particular. */}
          {target && target.id === p.id && (
            <div style={{ margin: '10px 0 4px' }}>
              <RemoveProjectConfirm
                key={target.id}
                project={target}
                onCancel={() => setConfirming(null)}
                onConfirm={() => {
                  const name = target.name;
                  setConfirming(null);
                  onRemoveProject(target.id);
                  setSaved({ tone: 'ok', text: `“${name}” and its recorded work were removed. The repository on disk was not touched.` });
                }}
              />
            </div>
          )}
        </Fragment>
      ))}

      <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 11, lineHeight: 1.5 }}>
        A project whose directory is not mounted right now is hidden from this list rather than
        removed, so an external disk that has not come back does not read as a project you deleted.
        Reconnect the volume and it reappears.
      </p>

      <Result r={saved} />
    </Section>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   1 · Observation
   ════════════════════════════════════════════════════════════════════════ */

function Observation({ prefs, pending, setFlag }: {
  prefs: WaniganSettings | null; pending: string | null; setFlag: (k: string, on: boolean) => Promise<void>;
}) {
  const listeners = useLoad(async () => {
    const [collector, server] = await Promise.all([
      window.wanigan.usage.collector(),
      window.wanigan.mcp.server(),
    ]);
    return { collector, server };
  });

  return (
    <Section title="Observation"
             hint="How Wanigan knows anything at all about a running agent. Telemetry and the hook bus default on: without them a session is a black rectangle that spends money.">
      <Note tone="info">
        <strong>Prompt and response content is never collected by these.</strong> Telemetry carries
        counts — tokens, cost, duration, model id. The hook bus carries tool names and one-line
        summaries such as the command run or the file touched. The only switch here that stores
        conversation text is <em>Archive transcripts</em>, and it says so on its own row.
        {' '}Wanigan pins the CLI's four content-logging variables —{' '}
        <span className="mono">OTEL_LOG_USER_PROMPTS</span> and its three siblings — to{' '}
        <span className="mono">false</span> on every launch rather than leaving them unset, so one of
        them switched on in your own shell cannot flow through into the database.
      </Note>

      {!prefs ? (
        <p className="dim" style={{ fontSize: 'var(--t-small)', marginTop: 12 }}>Reading your preferences…</p>
      ) : (
        <div style={{ marginTop: 12 }}>
          <Toggle title="Telemetry" on={prefs.telemetry} busy={pending === 'telemetry'}
                  onChange={(v) => void setFlag('telemetry', v)}>
            The CLI reports its own token counts, cost and request durations over OTLP to a receiver
            Wanigan opens on loopback. Every figure in Insights, the fleet and the budgets starts here.
            Turn it off and new sessions report nothing — the surfaces show no numbers rather than wrong ones.
          </Toggle>

          <Toggle title="Hook bus" on={prefs.hooks} busy={pending === 'hooks'}
                  onChange={(v) => void setFlag('hooks', v)}>
            Claude-compatible CLIs post an event when a tool starts, finishes, fails, or stops to ask
            for permission. With it off, those providers lose tool-level state. Codex uses its own
            per-session approval and completed-turn notification channel instead.
          </Toggle>

          <Toggle title="Archive transcripts" on={prefs.archiveTranscripts} busy={pending === 'archive_transcripts'}
                  onChange={(v) => void setFlag('archive_transcripts', v)}>
            Copies each conversation into Wanigan's local database so it can be searched after the
            session is gone. This is the one setting on this page that keeps prompt and response
            text. It is written to disk on this machine and sent nowhere; Storage below shows what
            it has accumulated and lets you delete any of it.
          </Toggle>

          <Toggle title="Desktop notifications" on={prefs.notifications} busy={pending === 'notifications'}
                  onChange={(v) => void setFlag('notifications', v)}>
            Raises an OS notification when an observed session asks for permission, fails, or finishes
            a turn. Wanigan hands the text to macOS and nothing leaves the machine.
          </Toggle>

          <Toggle title="Keep a pet" on={prefs.pet} busy={pending === 'pet'}
                  onChange={(v) => void setFlag('pet', v)}>
            A Tamagotchi in the corner of the Sessions view, emulated off the documented
            behaviour of the 1996 P1 — a fifteen-minute care window, two counters that never
            reset, and nothing left to chance. Off by default, because a tool that runs agents
            in your repositories should look like one until you decide otherwise.
          </Toggle>
        </div>
      )}

      <div className="set-sub">Listeners</div>
      <Frame v={listeners.v} what="the listener status" onRetry={listeners.reload}>
        {(d) => {
          const collectorMark: MarkSpec = d.collector.port !== null
            ? { glyph: '✓', word: 'listening', color: 'var(--good)' }
            : prefs && !prefs.telemetry
              ? { ...OFF, word: 'not started' }
              : { glyph: '⚠', word: 'not listening', color: 'var(--warning)' };

          return (
            <div className="sunk" style={{ padding: '4px 12px 11px' }}>
              <div className="set-scroll">
                <table className="grid" style={{ fontSize: 'var(--t-small)' }}>
                  <thead>
                    <tr>
                      <th>Listener</th><th>Status</th><th>Address</th><th>What it accepts</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ fontWeight: 600 }}>OTLP receiver</td>
                      <td><Mark {...collectorMark} /></td>
                      <td className="set-path">
                        {d.collector.port !== null ? `127.0.0.1:${d.collector.port}` : '—'}
                      </td>
                      <td className="dim">
                        {d.collector.port !== null
                          ? 'Metric counts from agents Wanigan launched.'
                          : prefs && !prefs.telemetry
                            ? 'Telemetry is off, so the receiver was never opened.'
                            : 'Telemetry is on now, but no port is bound — it was off when Wanigan started, or the socket failed. Restart to open it.'}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ fontWeight: 600 }}>Hook bus</td>
                      <td><Mark {...(prefs?.hooks ? { glyph: '✓', word: 'enabled', color: 'var(--good)' } : OFF)} /></td>
                      <td className="set-path dim">127.0.0.1, port assigned at launch</td>
                      <td className="dim">
                        Tool events, from a per-session config Wanigan writes at launch and deletes
                        when the session ends.
                      </td>
                    </tr>
                    <tr>
                      <td style={{ fontWeight: 600 }}>Wanigan MCP server</td>
                      <td><Mark {...(d.server ? { glyph: '✓', word: 'listening', color: 'var(--good)' } : OFF)} /></td>
                      <td className="set-path">{d.server ? d.server.url : '—'}</td>
                      <td className="dim">
                        {d.server
                          ? 'Tool calls from a session you pointed at it. See MCP below.'
                          : 'Off. Nothing is bound until you enable it in MCP below.'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.55, marginTop: 9 }}>
                All three bind to <span className="mono">127.0.0.1</span>, never{' '}
                <span className="mono">0.0.0.0</span> — nothing on your network can reach them, and each
                requires a bearer token minted fresh at launch, so a stray script or a web page that
                finds the port still cannot post to it. Ports are chosen by the OS, so they change
                every run.
              </p>
              <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.55, marginTop: 6 }}>
                A switch above applies to the next session you launch — an agent already running keeps
                the configuration it started with. The sockets themselves are opened once, when
                Wanigan starts: switching telemetry or the hook bus off stops new sessions reporting
                straight away, but the listener stays bound until you restart.
              </p>
              <button className="btn" style={{ marginTop: 9 }} onClick={listeners.reload}>Re-check listeners</button>
            </div>
          );
        }}
      </Frame>
    </Section>
  );
}

/* ── what leaves this machine ─────────────────────────────────────────────
   The one panel where a false statement would cost the most, so nothing on it
   is written here. The hosts, the pinned variables, the paths and the
   sentences about what cannot be enumerated all arrive from the main process,
   which is the side that actually knows them. A host list typed into the
   renderer would go on saying what was true the day it was typed, and would
   keep saying it after someone adds a sixth fetch() to a file this view has
   never heard of — a privacy claim that quietly stops being true is worse than
   no claim at all.
   ──────────────────────────────────────────────────────────────────────── */

/** Who opens the socket. An agent binary's own traffic is not Wanigan's to claim. */
const OPENED_BY: Record<EgressHost['by'], string> = {
  wanigan: 'Wanigan itself',
  agent: 'the agent CLI',
};

/**
 * Whether the condition beside it holds right now — a key stored, a provider
 * configured. Deliberately not the word "connected": Wanigan holds no
 * connection open to any of these, and a mark that implied otherwise would be
 * the overclaim this whole panel exists to avoid.
 */
function contactable(now: boolean | null): MarkSpec {
  if (now === null) return { glyph: '?', word: 'unknown', color: 'var(--text-dim)' };
  return now
    ? { glyph: '●', word: 'yes', color: 'var(--series-1)' }
    : { glyph: '○', word: 'no', color: 'var(--text-faint)' };
}

function Egress() {
  const report = useLoad(async () => window.wanigan.egress.report());

  return (
    <Section title="What leaves this machine"
             hint="Every host Wanigan can open a connection to and why, what is pinned off so it cannot, and where the data sits on this disk."
             right={<button className="btn" onClick={report.reload}>Re-read</button>}>
      <Frame v={report.v} what="what leaves this machine" onRetry={report.reload}>
        {(d) => (
          <>
            <div className="set-sub">Hosts</div>
            {!d.hosts.length ? (
              <div className="sunk set-empty">
                The report came back with no hosts at all. That is a bigger claim than this panel is
                willing to make on Wanigan's behalf — read it as the report failing, not as proof that
                nothing leaves.
              </div>
            ) : (
              <div className="set-scroll wide">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Host</th><th>Opened by</th><th>Why</th><th>Only when</th><th>Now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.hosts.map((h) => (
                      <tr key={`${h.by} ${h.host} ${h.purpose}`}>
                        <td>
                          <div className="set-path" style={{ fontWeight: 600 }}>{h.host}</div>
                          {h.paths.map((p) => <div key={p} className="faint set-path">{p}</div>)}
                          {h.overrideEnv && (
                            <div className="faint set-sub-line">
                              redirected by <span className="mono">{h.overrideEnv}</span>
                            </div>
                          )}
                        </td>
                        <td className="dim">{OPENED_BY[h.by]}</td>
                        <td className="dim" style={{ lineHeight: 1.45 }}>{h.purpose}</td>
                        <td className="dim" style={{ lineHeight: 1.45 }}>{h.when}</td>
                        <td><Mark {...contactable(h.activeNow)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.5 }}>
              “Now” answers the condition in the column beside it and nothing more. It does not mean a
              request is in flight: Wanigan keeps no connection open to any of these and reaches one
              only at the moment the thing under “why” happens.
            </p>
            <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 6, lineHeight: 1.5 }}>
              {d.provenance}
            </p>

            <div style={{ marginTop: 11 }}>
              <Callout level="warning"
                       title="This is Wanigan's own traffic. It is not everything that leaves this machine.">
                {d.unenumerated.length ? (
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {d.unenumerated.map((line) => <li key={line} style={{ marginTop: 4 }}>{line}</li>)}
                  </ul>
                ) : (
                  <p>
                    Nothing was reported here, which is not the same as there being nothing. Read the
                    table above as covering Wanigan's own code and no other program's.
                  </p>
                )}
              </Callout>
            </div>

            <div className="set-sub">Pinned off on every agent launch</div>
            {!d.pins.length ? (
              <div className="sunk set-empty">
                Nothing is reported as pinned. If that is right, each agent is launched with whatever
                your own shell has set for content logging — so treat the claim below about prompt
                text staying out of the database as unproven until this list fills.
              </div>
            ) : (
              <>
                <div className="set-scroll">
                  <table className="grid">
                    <thead><tr><th>Variable</th><th>Pinned to</th><th>What that prevents</th></tr></thead>
                    <tbody>
                      {d.pins.map((p) => (
                        <tr key={p.name}>
                          <td className="set-path">{p.name}</td>
                          <td className="mono" style={{ fontSize: 'var(--t-micro)' }}>{p.value}</td>
                          <td className="dim" style={{ lineHeight: 1.45 }}>{p.prevents}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.5 }}>
                  Pinned, not merely left unset. A spawned agent inherits Wanigan's own environment, so
                  one of these switched on in your shell would otherwise flow through the CLI and land
                  in the database on this machine. Setting them explicitly on every launch is what
                  makes the row true whatever your shell says.
                </p>
              </>
            )}

            <div className="set-sub">Where it sits on this disk</div>
            {!d.paths.length ? (
              <div className="sunk set-empty">
                No paths were reported. Wanigan does keep files — Storage below lists what it has —
                so read this as the report failing rather than as an empty disk.
              </div>
            ) : (
              <div className="set-scroll">
                <table className="grid">
                  <thead><tr><th>What</th><th>Where</th><th>Present</th></tr></thead>
                  <tbody>
                    {d.paths.map((p) => (
                      <tr key={p.path}>
                        <td>
                          <div style={{ fontWeight: 500 }}>{p.label}</div>
                          <div className="dim" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.45 }}>{p.what}</div>
                        </td>
                        <td className="set-path" style={{ userSelect: 'all' }}>{p.path}</td>
                        <td>
                          <Mark {...(p.exists
                            ? { glyph: '✓', word: 'on disk', color: 'var(--good)' }
                            : { glyph: '○', word: 'not yet', color: 'var(--text-faint)' })} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.5 }}>
              These files stay on this disk and are never copied wholesale. The optional Phone monitor
              exports only the allow-listed status fields described in its own section below; it never
              sends these files, repository paths, terminal bytes or transcripts. “Not yet” means
              nothing has been written there yet.
            </p>

            <div className="set-sub">What never leaves</div>
            <div className="sunk" style={{ padding: '10px 12px', fontSize: 'var(--t-small)', lineHeight: 1.55 }}>
              <p>
                <strong>The API key.</strong> It is sent as an auth header to the hosts in the table
                above and to nothing else, and it is never handed to this window — the key panel shows
                a fingerprint because a fingerprint is all the renderer is ever given. At rest it is
                encrypted by the OS credential store
                {d.keychainAvailable
                  ? '.'
                  : ', which this machine reports as unavailable right now — in that state Wanigan refuses to store a key at all rather than fall back to a plaintext file.'}
              </p>
              <p style={{ marginTop: 8 }}>
                <strong>Conversation text, into Wanigan's own measurements.</strong> The pinned
                variables above stop the CLI putting prompt and response content into the telemetry
                stream, so measuring what a session cost never copies what it said. Archived
                transcripts are the single exception: they are written to the transcripts directory
                above and nowhere else, and Storage below lists every one and will delete any of them.
              </p>
              <p style={{ marginTop: 8 }}>
                <strong>Your prompts do reach the model provider, though.</strong> That is what running
                an agent is, and pretending otherwise would be exactly the lie this panel exists to
                avoid. What Wanigan adds on top of it is nothing: no analytics host, no crash reporter,
                no account, no session sync, and no second copy of the conversation going anywhere but
                this disk.
              </p>
              <p style={{ marginTop: 8 }}>
                <strong>Nothing on the LAN can reach a listener directly.</strong> Wanigan binds its
                receivers to 127.0.0.1 rather than 0.0.0.0. If you explicitly configure Phone monitor
                with Tailscale Serve, that private proxy intentionally forwards authenticated,
                read-only dashboard requests from your tailnet to its loopback listener.
              </p>
            </div>
          </>
        )}
      </Frame>
    </Section>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Phone monitor
   ════════════════════════════════════════════════════════════════════════ */

function PhoneMonitor() {
  const [status, setStatus] = useState<MobileMonitorStatus | null>(null);
  const [server, setServer] = useState('https://ntfy.sh');
  const [topic, setTopic] = useState('');
  const [dashboardUrl, setDashboardUrl] = useState('');
  const [port, setPort] = useState('47831');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const absorb = useCallback((next: MobileMonitorStatus) => {
    setStatus(next);
    setServer(next.config.pushServer);
    setTopic(next.config.pushTopic);
    setDashboardUrl(next.config.dashboardUrl);
    setPort(String(next.config.port));
  }, []);

  const load = useCallback(() => {
    window.wanigan.mobile.status().then(absorb)
      .catch((e) => setResult({ tone: 'error', text: `Phone monitoring could not be read: ${msg(e)}` }));
  }, [absorb]);
  useEffect(() => { load(); }, [load]);

  const configure = useCallback(async (patch: Partial<MobileMonitorConfig>, label: string) => {
    setBusy(label); setResult(null);
    try {
      const next = await window.wanigan.mobile.configure(patch);
      absorb(next);
      if (next.config.dashboardEnabled && !next.running) {
        throw new Error(next.error ?? 'The loopback listener did not start.');
      }
      setResult({ tone: 'ok', text: label });
    } catch (e) {
      setResult({ tone: 'error', text: `${label} failed: ${msg(e)}` });
    } finally { setBusy(null); }
  }, [absorb]);

  async function copy(value: string, what: string) {
    try {
      await navigator.clipboard.writeText(value);
      setResult({ tone: 'ok', text: `${what} copied.` });
    } catch (e) {
      setResult({ tone: 'error', text: `The clipboard refused the write: ${msg(e)}` });
    }
  }

  async function saveConnection() {
    const parsedPort = Number(port);
    await configure({
      port: parsedPort,
      dashboardUrl: dashboardUrl.trim(),
      pushServer: server.trim(),
      pushTopic: topic.trim(),
    }, 'Phone connection settings saved');
  }

  async function testPush() {
    setBusy('test'); setResult(null);
    try {
      const next = await window.wanigan.mobile.configure({
        pushServer: server.trim(), pushTopic: topic.trim(), dashboardUrl: dashboardUrl.trim(),
      });
      absorb(next);
      const tested = await window.wanigan.mobile.testPush();
      setResult({ tone: tested.ok ? 'ok' : 'error', text: tested.detail });
      absorb(await window.wanigan.mobile.status());
    } catch (e) {
      setResult({ tone: 'error', text: `Test alert failed: ${msg(e)}` });
    } finally { setBusy(null); }
  }

  const serveCommand = `tailscale serve --bg ${status?.config.port ?? 47831}`;

  return (
    <Section title="Phone monitor"
             hint="Walk away without losing the fleet: a private read-only status page and opt-in phone alerts for the same states as desktop notifications.">
      <Callout title="The dashboard is read-only until you explicitly enable iPad control.">
        Read-only monitoring receives the Mac hostname, Wanigan version, an internal session id, project/session
        names, provider/model, state, timestamps, spend and aggregate usage. With paired iPad control enabled,
        the selected session’s terminal output is also shown and may contain paths, prompt text, or other sensitive
        text printed by an agent. Treat every paired device as trusted. It does not expose permission approval.
      </Callout>

      {!status ? (
        <p className="dim" style={{ fontSize: 'var(--t-small)', marginTop: 12 }}>Reading phone monitoring…</p>
      ) : (
        <>
          {status.error && !status.config.dashboardEnabled && (
            <div style={{ marginTop: 10 }}><Callout level="critical" title={status.error} /></div>
          )}
          <div className="set-sub">Read-only Fleet page</div>
          <Toggle title="Run the phone dashboard" on={status.config.dashboardEnabled} busy={busy !== null}
                  onChange={(on) => void configure({ dashboardEnabled: on }, on ? 'Phone dashboard started' : 'Phone dashboard stopped')}>
            Opens an authenticated HTTP service on <span className="mono">127.0.0.1</span> only.
            A phone cannot reach that listener directly; a private HTTPS reverse proxy such as Tailscale Serve connects it without opening Wanigan to the LAN or public internet.
          </Toggle>

          <Toggle title="Allow paired iPad control" on={status.config.remoteControlEnabled} busy={busy !== null}
                  onChange={(on) => void configure({ remoteControlEnabled: on }, on ? 'Paired iPad control enabled' : 'Paired iPad control disabled')}>
            Requires the dashboard above. A paired browser can start an agent session, view its live terminal,
            send its next instruction, or interrupt a turn. It cannot approve permissions, manage files, or change settings.
          </Toggle>

          {status.config.dashboardEnabled && (
            <div className="sunk" style={{ padding: '12px 13px', marginTop: 10 }}>
              <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
                <Mark {...(status.running
                  ? { glyph: '✓', word: 'listening', color: 'var(--good)' }
                  : { glyph: '✕', word: 'not listening', color: 'var(--critical)' })} />
                <code className="set-path">{status.localUrl}</code>
              </div>
              {status.error && <div style={{ marginTop: 9 }}><Callout level="critical" title={status.error} /></div>}

              <div className="row2" style={{ marginTop: 12 }}>
                <div>
                  <label className="label" htmlFor="mobile-port">Loopback port</label>
                  <input id="mobile-port" className="field mono" inputMode="numeric" value={port}
                         onChange={(e) => setPort(e.target.value)} disabled={busy !== null} />
                </div>
                <div>
                  <label className="label" htmlFor="mobile-url">Private HTTPS URL</label>
                  <input id="mobile-url" className="field mono" value={dashboardUrl}
                         placeholder="https://this-mac.example.ts.net" spellCheck={false}
                         onChange={(e) => setDashboardUrl(e.target.value)} disabled={busy !== null} />
                </div>
              </div>
              <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.55, marginTop: 6 }}>
                Install Tailscale on this Mac and your phone, run the command below once, then paste the HTTPS URL it prints.
                Wanigan stays bound to loopback; tailnet ACLs and the pairing token both still apply.
                Tailscale&apos;s background Serve mapping persists independently: turning this switch off or changing ports does not remove it,
                so disable/reset that mapping in Tailscale when you stop using it.
              </p>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 9, flexWrap: 'wrap' }}>
                <code className="set-path" style={{ userSelect: 'all', flex: 1 }}>{serveCommand}</code>
                <button className="set-mini" onClick={() => void copy(serveCommand, 'Tailscale command')}>copy command</button>
                <a className="set-mini" style={{ textDecoration: 'none' }} href="https://tailscale.com/download" target="_blank" rel="noreferrer">get Tailscale</a>
              </div>

              <div style={{ marginTop: 13 }}>
                <label className="label">Pairing code</label>
                <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 5 }}>
                  <code className="set-path" style={{ letterSpacing: '0.12em', fontWeight: 700 }}>{status.pairingCode}</code>
                  <button className="set-mini" onClick={() => void copy(status.pairingCode, 'Pairing code')}>copy code</button>
                </div>
                <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.55, marginTop: 6 }}>
                  Type this code in the Home Screen Wanigan app. It expires after ten minutes; reopen this panel for a fresh code.
                </p>
              </div>

              <div style={{ marginTop: 13 }}>
                <label className="label">Pairing link</label>
                <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 5, flexWrap: 'wrap' }}>
                  <code className="set-path" style={{ userSelect: 'all', flex: 1, overflowWrap: 'anywhere' }}>{status.pairingUrl}</code>
                  <button className="set-mini" disabled={!status.running || !status.config.dashboardUrl}
                          onClick={() => void copy(status.pairingUrl, 'Pairing link')}>copy link</button>
                  <button className="set-mini" disabled={busy !== null}
                          onClick={async () => {
                            setBusy('rotate'); setResult(null);
                            try { absorb(await window.wanigan.mobile.regenerateToken()); setResult({ tone: 'ok', text: 'Old pairing links were revoked.' }); }
                            catch (e) { setResult({ tone: 'error', text: `The pairing token was not changed: ${msg(e)}` }); }
                            finally { setBusy(null); }
                          }}>revoke &amp; replace</button>
                </div>
                <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.55, marginTop: 6 }}>
                  Open this once on the phone. The credential sits after <span className="mono">#</span>, so it is absent from the initial navigation request and Referer;
                  the page saves it on that device, removes it from the address bar, then sends it only as the Authorization header on status requests.
                  Replacing it immediately signs every paired browser out.
                  {!status.config.dashboardUrl && ' Save the private HTTPS URL above before copying this link to a phone.'}
                </p>
              </div>
            </div>
          )}

          <div className="set-sub">Phone alerts · ntfy</div>
          <Toggle title="Send alerts to ntfy" on={status.config.pushEnabled} busy={busy !== null}
                  onChange={(on) => void configure({
                    pushEnabled: on, pushServer: server.trim(), pushTopic: topic.trim(), dashboardUrl: dashboardUrl.trim(),
                  }, on ? 'Phone alerts enabled' : 'Phone alerts disabled')}>
            Sends only notification title, project name, state and wait time. Prompt text,
            commands, paths and terminal output are excluded. Permission waits and errors use ntfy&apos;s urgent/maximum priority;
            finished turns are normal priority.
          </Toggle>
          <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.55, marginTop: 6 }}>
            Built-in Claude-compatible and Codex sessions expose those in-turn states. A provider pack
            without a lifecycle channel still reports process exit, but not arbitrary prompts inferred from terminal text.
          </p>

          <div className="sunk" style={{ padding: '12px 13px', marginTop: 10 }}>
            <div className="row2">
              <div>
                <label className="label" htmlFor="mobile-ntfy-server">ntfy server</label>
                <input id="mobile-ntfy-server" className="field mono" value={server} spellCheck={false}
                       onChange={(e) => setServer(e.target.value)} disabled={busy !== null} />
              </div>
              <div>
                <label className="label" htmlFor="mobile-ntfy-topic">Private topic</label>
                <input id="mobile-ntfy-topic" className="field mono" value={topic} spellCheck={false}
                       onChange={(e) => setTopic(e.target.value)} disabled={busy !== null} />
              </div>
            </div>
            <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.55, marginTop: 6 }}>
              Install the ntfy app and subscribe to this exact topic on the server above. The generated topic is the subscription credential:
              anyone who learns it can subscribe or publish, so do not use a guessable word. With <span className="mono">ntfy.sh</span>, the alert text leaves this machine for delivery.
            </p>
            <div style={{ display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn" disabled={busy !== null} onClick={() => void saveConnection()}>Save connection</button>
              <button className="btn" disabled={busy !== null || !topic.trim()} onClick={() => void testPush()}>
                {busy === 'test' ? 'Sending…' : 'Send test alert'}
              </button>
              <button className="set-mini" disabled={!topic.trim()} onClick={() => void copy(topic.trim(), 'ntfy topic')}>copy topic</button>
              <button className="set-mini" disabled={busy !== null}
                      onClick={async () => {
                        setBusy('topic'); setResult(null);
                        try {
                          const next = await window.wanigan.mobile.regenerateTopic();
                          absorb(next);
                          setResult({ tone: 'ok', text: 'Wanigan now uses the replacement topic. Unsubscribe the old one in ntfy; ntfy topics themselves cannot be revoked.' });
                        } catch (e) { setResult({ tone: 'error', text: `The ntfy topic was not changed: ${msg(e)}` }); }
                        finally { setBusy(null); }
                      }}>replace topic</button>
              <a className="set-mini" style={{ textDecoration: 'none' }} href="https://ntfy.sh" target="_blank" rel="noreferrer">get ntfy</a>
            </div>
            {(status.lastPushAt || status.lastPushError) && (
              <p className={status.lastPushError ? 'critical' : 'faint'} style={{ fontSize: 'var(--t-micro)', marginTop: 8 }}>
                {status.lastPushError
                  ? `Last delivery failed: ${status.lastPushError}`
                  : `Last alert accepted by ntfy ${status.lastPushAt ? ago(status.lastPushAt) : 'recently'} (device receipt is not reported).`}
              </p>
            )}
          </div>
        </>
      )}
      <Result r={result} />
    </Section>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   2 · Trust and the policy ledger
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Time ranges for the ledger, as windows rather than as a free-form date box.
 *
 * An incident is remembered as "this afternoon" or "some time last week", not
 * as a pair of timestamps, and a window is also the only shape that stays
 * honest against a bounded fetch: it narrows what is already loaded rather than
 * implying a query over the whole table.
 */
/** The ceiling main clamps a ledger read to; asking for more returns no more. */
const LEDGER_MAX_ROWS = 5000;
const nextLedgerLimit = (current: number) => Math.min(LEDGER_MAX_ROWS, current * 5);

const LEDGER_WINDOWS: { id: string; word: string; ms: number | null }[] = [
  { id: 'all', word: 'Any time', ms: null },
  { id: '1h', word: 'Last hour', ms: 60 * 60 * 1000 },
  { id: '24h', word: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', word: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', word: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
];

function Trust({ projects, onAddProject }: { projects: Project[]; onAddProject: () => void }) {
  const [deniedOnly, setDeniedOnly] = useState(false);
  const [saved, setSaved] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  // Scoping an incident: which session, which project, when, and what it said.
  const [sessionFilter, setSessionFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [windowId, setWindowId] = useState('all');
  const [query, setQuery] = useState('');
  const [ledgerLimit, setLedgerLimit] = useState(200);

  const trust = useLoad(async () => {
    const [dflt, perProject] = await Promise.all([
      window.wanigan.policy.defaultTrust(),
      Promise.all(projects.map(async (p) => ({ id: p.id, level: await window.wanigan.policy.trust(p.id) }))),
    ]);
    return { dflt, perProject: new Map(perProject.map((r) => [r.id, r.level])) };
  }, [projects.length]);

  const summary = useLoad(() => window.wanigan.policy.summary());
  const ledger = useLoad(() => window.wanigan.policy.ledger(ledgerLimit, deniedOnly), [deniedOnly, ledgerLimit]);

  const pick = async (fn: () => Promise<unknown>, text: string) => {
    setSaved(null);
    try { await fn(); trust.reload(); setSaved({ tone: 'ok', text }); }
    catch (e) { setSaved({ tone: 'error', text: msg(e) }); }
  };

  // Session ids come from the rows themselves: a session that made no tool call
  // has nothing in the ledger, and offering it as a filter would promise a view
  // that is empty for a reason the operator cannot see.
  const loadedSessions = useMemo(() => {
    if (ledger.v.s !== 'ok') return [] as string[];
    const seen = new Set<string>();
    for (const r of ledger.v.d) if (r.sessionId) seen.add(r.sessionId);
    return [...seen];
  }, [ledger.v]);

  const filtersActive = Boolean(sessionFilter || projectFilter || query.trim()) || windowId !== 'all';

  const matches = useCallback((r: LedgerEntry) => {
    if (sessionFilter && r.sessionId !== sessionFilter) return false;
    if (projectFilter && r.projectId !== projectFilter) return false;
    const span = LEDGER_WINDOWS.find((w) => w.id === windowId)?.ms ?? null;
    if (span !== null && r.at < Date.now() - span) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${r.toolName} ${r.summary} ${r.rule} ${r.reason} ${r.projectName ?? ''}`.toLowerCase().includes(q);
  }, [sessionFilter, projectFilter, windowId, query]);

  async function exportLedger() {
    setExporting(true); setSaved(null);
    try {
      const r = await window.wanigan.policy.exportTo();
      setSaved(r
        ? { tone: 'ok', text: `Wrote ${plural(r.rows, 'decision')} to ${r.path}.` }
        : { tone: 'ok', text: 'Export canceled. Nothing was written.' });
    } catch (e) {
      setSaved({ tone: 'error', text: `The ledger was not exported: ${msg(e)}` });
    } finally { setExporting(false); }
  }

  return (
    <Section title="Trust and the policy ledger"
             hint="What an agent in a project is allowed to reach for, and a written record of every decision Wanigan made about it.">
      <Callout level="warning" title="This is defence in depth. It is not containment, and it is not a security boundary.">
        Wanigan checks each tool call against the level below and writes the answer down. It does not
        sandbox the agent, it cannot see inside a command it allowed, and it cannot stop a process
        that is already running. The 2026 Claude Code CVEs went <em>through allowlisted commands</em> —
        a permitted tool doing an unexpected thing is exactly the case a policy layer is blind to.
        The OS sandbox is the boundary. Treat this as an audit trail with brakes, and do not point an
        agent at anything on the strength of it.
      </Callout>

      <div className="set-sub">Default trust for new projects</div>
      <Frame v={trust.v} what="the trust levels" onRetry={trust.reload}>
        {(d) => (
          <>
            <Options
              label="Default trust level"
              value={d.dflt}
              options={TRUST_LEVELS.map((lv) => ({ id: lv, word: TRUST_COPY[lv].label, detail: TRUST_COPY[lv].detail }))}
              onPick={(lv) => void pick(
                () => window.wanigan.policy.setDefaultTrust(lv),
                `New projects now start at ${TRUST_COPY[lv].label}. Projects with their own level below are unchanged.`,
              )}
            />

            <div className="set-sub">Per-project override</div>
            {!projects.length ? (
              <div className="sunk set-empty">
                No projects yet, so there is nothing to override.
                <div style={{ marginTop: 9 }}>
                  <button className="btn" onClick={onAddProject}>+ Add a project</button>
                </div>
              </div>
            ) : (
              <div className="set-scroll">
                <table className="grid">
                  <thead><tr><th>Project</th><th>Trust</th><th>Effect</th></tr></thead>
                  <tbody>
                    {projects.map((p) => {
                      const lv = d.perProject.get(p.id) ?? d.dflt;
                      return (
                        <tr key={p.id}>
                          <td>
                            <div style={{ fontWeight: 500 }}>{p.name}</div>
                            <div className="faint set-path set-wrap">{p.path}</div>
                          </td>
                          <td>
                            <select className="field" style={{ width: 118 }} value={lv}
                                    aria-label={`Trust level for ${p.name}`}
                                    onChange={(e) => {
                                      const next = e.target.value as TrustLevel;
                                      void pick(
                                        () => window.wanigan.policy.setTrust(p.id, next),
                                        `${p.name} is now ${TRUST_COPY[next].label}. It no longer follows the default.`,
                                      );
                                    }}>
                              {TRUST_LEVELS.map((t) => <option key={t} value={t}>{TRUST_COPY[t].label}</option>)}
                            </select>
                          </td>
                          <td className="dim" style={{ fontSize: 'var(--t-small)', lineHeight: 1.45 }}>
                            {TRUST_COPY[lv].detail}
                            {lv === d.dflt && (
                              <span className="faint"> — same as the default.</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.5 }}>
              Changing a project here pins it: it stops following the default from that moment on.
              A level takes effect on the next tool call, not on sessions already mid-command.
            </p>
          </>
        )}
      </Frame>

      <div className="set-sub">Ledger</div>
      <Frame v={summary.v} what="the ledger summary" onRetry={summary.reload}>
        {(s) => {
          const total = s.denied + s.asked + s.allowed;
          if (!total) {
            return (
              <div className="sunk set-empty">
                The ledger is empty — no agent has called a tool through a Wanigan session yet.
                <div className="faint" style={{ marginTop: 6, fontSize: 'var(--t-small)' }}>
                  It fills on its own once the hook bus is on and a session runs. Nothing to configure.
                </div>
              </div>
            );
          }
          return (
            <>
              <div className="row3">
                <Stat label="⊘ Denied" value={num(s.denied)} tone={s.denied ? 'var(--critical)' : undefined}
                      sub={`${((s.denied / total) * 100).toFixed(1)}% of calls`} />
                <Stat label="? Asked" value={num(s.asked)} tone={s.asked ? 'var(--warning)' : undefined}
                      sub={`${((s.asked / total) * 100).toFixed(1)}% of calls`} />
                <Stat label="✓ Allowed" value={num(s.allowed)}
                      sub={`${((s.allowed / total) * 100).toFixed(1)}% of calls`} />
              </div>
              <p className="dim" style={{ fontSize: 'var(--t-small)', marginTop: 8, lineHeight: 1.5 }}>
                {plural(total, 'decision')} recorded
                {s.since ? <> since {fullDate(s.since)}</> : null}. An allow is still a row: the point of
                the ledger is that everything is written down, not only the refusals.
              </p>
            </>
          );
        }}
      </Frame>

      <div className="set-filters">
        <div className="set-chips" role="group" aria-label="Ledger decision filter">
          <button className={`set-chip${deniedOnly ? '' : ' on'}`} aria-pressed={!deniedOnly}
                  onClick={() => setDeniedOnly(false)}>Every decision</button>
          <button className={`set-chip${deniedOnly ? ' on' : ''}`} aria-pressed={deniedOnly}
                  onClick={() => setDeniedOnly(true)}>⊘ Denied only</button>
        </div>
        <div className="set-filter-field">
          <label className="label" htmlFor="ledger-session">Session</label>
          <select id="ledger-session" className="field" value={sessionFilter}
                  onChange={(e) => setSessionFilter(e.target.value)}>
            <option value="">Every session</option>
            {loadedSessions.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </div>
        <div className="set-filter-field">
          <label className="label" htmlFor="ledger-project">Project</label>
          <select id="ledger-project" className="field" value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="">Every project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="set-filter-field">
          <label className="label" htmlFor="ledger-window">When</label>
          <select id="ledger-window" className="field" value={windowId}
                  onChange={(e) => setWindowId(e.target.value)}>
            {LEDGER_WINDOWS.map((w) => <option key={w.id} value={w.id}>{w.word}</option>)}
          </select>
        </div>
        <div className="set-filter-field grow">
          <label className="label" htmlFor="ledger-q">Tool, target or rule contains</label>
          <input id="ledger-q" className="field" value={query} spellCheck={false} placeholder="Bash, .env, WebFetch…"
                 onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="set-filter-actions">
          {filtersActive && (
            <button className="btn" onClick={() => {
              setSessionFilter(''); setProjectFilter(''); setWindowId('all'); setQuery('');
            }}>Clear filters</button>
          )}
          <button className="btn" onClick={exportLedger} disabled={exporting}>
            {exporting ? 'Choosing a file…' : 'Export ledger (JSONL)'}
          </button>
        </div>
      </div>

      <Frame v={ledger.v} what="the ledger" onRetry={ledger.reload}>
        {(rows) => {
          if (!rows.length) {
            return deniedOnly ? (
              <div className="sunk set-empty">
                No denials in the ledger. Every tool call an agent made was allowed or asked.
                <div style={{ marginTop: 9 }}>
                  <button className="btn" onClick={() => setDeniedOnly(false)}>Show every decision</button>
                </div>
              </div>
            ) : (
              <div className="sunk set-empty">
                Nothing recorded yet. The ledger fills the first time an agent calls a tool while the
                hook bus is on.
              </div>
            );
          }
          // Loaded-but-excluded is not the same answer as nothing-recorded, and
          // the difference is the whole point of a filter: one says the incident
          // is not here, the other says you have not looked far enough back.
          const shown = rows.filter(matches);
          if (!shown.length) {
            return (
              <div className="sunk set-empty">
                None of the {plural(rows.length, 'loaded decision')} match this filter.
                <div className="faint" style={{ marginTop: 6, fontSize: 'var(--t-small)' }}>
                  Rows are filtered after they are read, so an older decision may simply not be loaded
                  yet. Widen the time window, clear the filters, or load more rows.
                </div>
                <div style={{ marginTop: 9, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  <button className="btn" onClick={() => {
                    setSessionFilter(''); setProjectFilter(''); setWindowId('all'); setQuery('');
                  }}>Clear filters</button>
                  {ledgerLimit < LEDGER_MAX_ROWS && (
                    <button className="btn" onClick={() => setLedgerLimit(nextLedgerLimit(ledgerLimit))}>
                      Load {num(nextLedgerLimit(ledgerLimit))} rows instead
                    </button>
                  )}
                </div>
              </div>
            );
          }
          return (
            <>
              <div className="set-scroll wide">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>When</th><th>Project &amp; session</th><th>Tool</th>
                      <th>What it asked for</th><th>Decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.id}>
                        {/* The exact instant was a tooltip, which an incident
                            review on a tablet could not reach at all. */}
                        <td className="set-when">
                          {ago(r.at)}
                          <div className="faint set-sub-line">{fullDate(r.at)}</div>
                        </td>
                        <td style={{ maxWidth: 170 }}>
                          {r.projectName ?? <span className="faint">no project</span>}
                          <div className="faint set-sub-line">{TRUST_COPY[r.trust]?.label ?? r.trust}</div>
                          {r.sessionId
                            ? <div className="faint set-path set-wrap">{r.sessionId}</div>
                            : <div className="faint set-sub-line">no session</div>}
                        </td>
                        <td className="mono" style={{ fontSize: 'var(--t-small)' }}>{r.toolName}</td>
                        <td className="dim" style={{ maxWidth: 300 }}>
                          <div className="set-wrap">{r.summary}</div>
                          <div className="faint set-sub-line">rule: {r.rule}</div>
                          <div className="faint set-wrap" style={{ fontSize: '10.5px', marginTop: 2 }}>{r.reason}</div>
                        </td>
                        <td><Mark {...DECISION[r.decision]} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.5 }}>
                {filtersActive
                  ? <>Showing {num(shown.length)} of the {plural(rows.length, 'decision')} loaded. Filters run over
                      what is loaded, not over the whole table.</>
                  : <>Showing the {plural(shown.length, 'most recent row', 'most recent rows')}
                      {deniedOnly ? ' that were denied' : ''}.</>}
                {' '}Export writes the whole ledger, one JSON object per line, including the reason each
                rule gave. Every command, path, URL and search pattern here passes through the shared
                credential redactor before it is stored.
              </p>
              {ledgerLimit < LEDGER_MAX_ROWS && (
                <button className="btn" style={{ marginTop: 9 }} onClick={() => setLedgerLimit(nextLedgerLimit(ledgerLimit))}>
                  Load {num(nextLedgerLimit(ledgerLimit))} rows instead of {num(ledgerLimit)}
                </button>
              )}
            </>
          );
        }}
      </Frame>

      <Result r={saved} />
    </Section>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   3 · Dispatcher
   ════════════════════════════════════════════════════════════════════════ */

const KIND_COPY: { id: keyof QueueSlots; label: string; detail: string; overLimit: string }[] = [
  {
    id: 'session', label: 'Interactive sessions', detail: 'Terminals you drive yourself.',
    overLimit: 'A launch past this limit is refused, not queued — you are standing in front of the terminal, so Wanigan says no rather than silently holding it.',
  },
  {
    id: 'headless', label: 'Headless runs', detail: 'One unattended agent per repo.',
    overLimit: 'Work past this limit waits in the queue below and starts on a later tick.',
  },
  {
    id: 'batch', label: 'Batch submissions', detail: 'Submissions in flight against the Batches API.',
    overLimit: 'Work past this limit waits in the queue below and starts on a later tick.',
  },
  {
    id: 'scout', label: 'Improvement Scout', detail: 'One bounded official-source research pass at a time.',
    overLimit: 'Work past this limit waits in the queue below and starts on a later tick.',
  },
];

/**
 * The four states a meter can be in are four renderings.
 *
 * "Still reading", "the read failed", "nothing is running" and "n of m are
 * running" are different facts, and a meter that draws an empty bar for all
 * four is the shape of the bug this replaced: the interactive row counted
 * queue rows, an interactive launch never makes one, and the surface that sets
 * the enforced limit reported nothing running no matter what was.
 */
function SlotMeter({ load, limit, enforcedLimit, source }: {
  load: Load<number>; limit: number; enforcedLimit: number | null; source: string;
}) {
  if (load.s === 'loading') {
    return <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 6 }}>Reading what is running…</p>;
  }
  if (load.s === 'err') {
    return (
      <p style={{ fontSize: 'var(--t-micro)', marginTop: 6, color: 'var(--warning)', lineHeight: 1.5 }}>
        ⚠ Wanigan could not read what is running: {load.e} — the limit beside this row is still the one
        it enforces.
      </p>
    );
  }
  const inUse = load.d;
  const shown = Math.max(1, enforcedLimit ?? limit);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 6, maxWidth: 320 }}>
        <div className="set-meter" style={{ flex: 1 }}>
          <span style={{ width: `${Math.min(100, (inUse / shown) * 100)}%` }} />
        </div>
        <span className="faint" style={{ fontSize: 'var(--t-micro)', fontVariantNumeric: 'tabular-nums' }}>
          {inUse === 0 ? `none of ${shown} running` : `${inUse} of ${shown} running`}
        </span>
      </div>
      <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 3, lineHeight: 1.45 }}>
        {source}
        {enforcedLimit !== null && enforcedLimit !== limit && (
          <> Saving changes the enforced limit to {num(limit)}.</>
        )}
      </p>
    </>
  );
}

function Dispatcher({ active }: { active: boolean }) {
  const [draft, setDraft] = useState<QueueSlots | null>(null);
  const [saved, setSaved] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [tick, setTick] = useState(0);

  const slots = useLoad(() => window.wanigan.queue.slots());
  const queue = useLoad(() => window.wanigan.queue.list(60), [tick]);
  // Interactive sessions never create a queue row, so counting queue rows made
  // this meter read "0 of N" forever — on the very page whose number the
  // launcher enforces. This reads the live PTY count and the limit from the
  // same slots() call the refusal uses, so the two cannot disagree.
  const interactive = useLoad(() => window.wanigan.sessions.liveCount(), [tick]);

  // The queue moves on its own, so the table follows it rather than waiting for
  // the user to come back and reopen the page.
  useEffect(() => {
    if (!active) return;
    const off = window.wanigan.on.queueChanged(() => setTick((t) => t + 1));
    const timer = setInterval(() => setTick((t) => t + 1), 5000);
    return () => { off(); clearInterval(timer); };
  }, [active]);

  const running = useMemo(() => {
    const by: Record<string, number> = { session: 0, headless: 0, batch: 0, scout: 0 };
    if (queue.v.s === 'ok') for (const q of queue.v.d) if (q.state === 'running') by[q.kind] = (by[q.kind] ?? 0) + 1;
    return by;
  }, [queue.v]);

  async function saveSlots(next: QueueSlots) {
    setSaved(null);
    try {
      const applied = await window.wanigan.queue.setSlots(next);
      setDraft(applied);
      slots.reload();
      interactive.reload();
      setSaved({
        tone: 'ok',
        text: `Saved. Headless runs, batch submissions and Scout passes above ${applied.headless}, `
          + `${applied.batch} and ${applied.scout} wait in the queue. An interactive session is not `
          + `queued: starting one while ${applied.session} ${applied.session === 1 ? 'is' : 'are'} already `
          + 'running is refused, with a message naming this limit.',
      });
    } catch (e) { setSaved({ tone: 'error', text: `Slots were not saved: ${msg(e)}` }); }
  }

  async function cancel(item: QueueItem) {
    setSaved(null);
    try {
      const ok = await window.wanigan.queue.cancel(item.id);
      setSaved(ok
        ? { tone: 'ok', text: `Canceled “${item.label}”. It never started, so nothing was spent.` }
        : { tone: 'error', text: `“${item.label}” had already left the waiting state, so there was nothing to cancel. Stop the ${item.kind} itself instead.` });
      setTick((t) => t + 1);
    } catch (e) { setSaved({ tone: 'error', text: msg(e) }); }
  }

  return (
    <Section title="Dispatcher"
             hint="How much Wanigan starts at once, and what is holding. Headless runs, batch submissions and Scout passes above their limit wait in the queue; an interactive session above its limit is refused instead, because there is a person waiting at the terminal.">
      <Frame v={slots.v} what="the slot limits" onRetry={slots.reload}>
        {(loaded) => {
          const d = draft ?? loaded;
          const dirty = (['session', 'headless', 'batch', 'scout'] as const).some((k) => d[k] !== loaded[k]);
          return (
          <>
            {KIND_COPY.map(({ id, label, detail, overLimit }) => {
              // The interactive row is the only one whose live figure is not a
              // queue row, so it is the only one that reads its own channel.
              const live: Load<number> = id === 'session'
                ? interactive.v.s === 'ok'
                  ? { s: 'ok', d: interactive.v.d.live }
                  : interactive.v
                : queue.v.s === 'ok'
                  ? { s: 'ok', d: running[id] ?? 0 }
                  : queue.v;
              const enforced = id === 'session' && interactive.v.s === 'ok'
                ? interactive.v.d.limit
                : loaded[id];
              return (
                <div className="set-row" key={id}>
                  <div className="txt">
                    <h4>{label}</h4>
                    <p>{detail} {overLimit}</p>
                    <SlotMeter
                      load={live}
                      limit={Math.max(1, d[id])}
                      enforcedLimit={enforced}
                      source={id === 'session'
                        ? 'Counted from the sessions holding a terminal right now, against the limit the launcher itself checks.'
                        : 'Counted from queue rows in the running state.'}
                    />
                  </div>
                  <label style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span className="label">slots</span>
                    <input className="field mono" type="number" min={1} max={64} style={{ width: 72, textAlign: 'right' }}
                           aria-label={`${label} slots`} value={d[id]}
                           onChange={(e) => setDraft({ ...d, [id]: Number(e.target.value) })} />
                  </label>
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 11 }}>
              <button className="btn btn-primary" onClick={() => void saveSlots(d)} disabled={!dirty}>Save slots</button>
              {dirty && (
                <button className="btn" onClick={() => setDraft(loaded)}>Discard changes</button>
              )}
              <button className="btn" onClick={() => { interactive.reload(); setTick((t) => t + 1); }}>Re-count</button>
              <span className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.45 }}>
                1 to 64 per surface. Lowering a number never stops work already running.
              </span>
            </div>
            <div style={{ marginTop: 11 }}>
              <Callout level="warning" title="Lowering the interactive limit takes effect on the next launch, as a refusal.">
                Every other surface here queues. Interactive sessions do not: the launcher re-reads
                this number and refuses to start a terminal once that many are already open, naming
                this setting in the message. Set it below the number currently running and the
                sessions already open keep running — you simply cannot start another until enough of
                them exit.
              </Callout>
            </div>
          </>
          );
        }}
      </Frame>

      <div className="set-sub">Queue</div>
      <Frame v={queue.v} what="the queue" onRetry={queue.reload}>
        {(items) => {
          if (!items.length) {
            return (
              <div className="sunk set-empty">
                The queue is empty. Nothing is waiting and nothing is being held back.
                <div className="faint" style={{ marginTop: 6, fontSize: 'var(--t-small)' }}>
                  Work only lands here when every slot for its kind is already busy — start more
                  sessions, headless runs or submissions than the limits above and they queue instead
                  of fighting for the machine.
                </div>
              </div>
            );
          }
          return (
            <div className="set-scroll wide">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Item</th><th>Kind</th><th>State</th><th>Why</th>
                    <th className="r">Age</th><th className="r">Tries</th><th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((q) => {
                    const s = QUEUE_STATE[q.state];
                    const age = (q.endedAt ?? Date.now()) - q.createdAt;
                    return (
                      <tr key={q.id}>
                        <td className="set-wrap" style={{ maxWidth: 210 }}>{q.label}</td>
                        <td className="dim">{q.kind}</td>
                        <td><Mark {...s} /></td>
                        {/* Why an item is stuck is the reason to open this table
                            at all, so it is text, not a hover. */}
                        <td className="dim set-wrap" style={{ maxWidth: 240 }}>
                          {q.error ?? q.blockedBy ?? <span className="faint">—</span>}
                          {q.nextAttemptAt && q.state === 'waiting' && (
                            <div className="faint" style={{ fontSize: 'var(--t-micro)' }}>retry {ago(q.nextAttemptAt)}</div>
                          )}
                        </td>
                        <td className="set-n">{dur(age)}</td>
                        <td className="set-n">{num(q.attempts)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {q.state === 'waiting' ? (
                            <button className="set-mini danger" onClick={() => void cancel(q)}>cancel</button>
                          ) : (
                            <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>
                              {q.state === 'running' ? 'stop it where it runs' : '—'}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        }}
      </Frame>
      <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.5 }}>
        The 60 most recent items, finished ones included, refreshed as the dispatcher moves. Only a
        waiting item can be canceled here — once it has started the queue no longer owns it, so stop
        the session or the run itself.
      </p>

      <Result r={saved} />
    </Section>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   4 · MCP
   ════════════════════════════════════════════════════════════════════════ */

type Draft = {
  id?: string; name: string; projectId: string;
  transport: 'stdio' | 'http'; command: string; args: string; url: string; enabled: boolean;
};

const BLANK: Draft = { name: '', projectId: '', transport: 'stdio', command: '', args: '', url: '', enabled: false };

/** The placeholder writeMcpConfig substitutes when it writes a session config. */
const PROJECT_PATH_SLOT = '{{PROJECT_PATH}}';

/**
 * The command line as it will be handed to the agent's CLI, with the scope it
 * runs in, so the thing being approved is the thing being displayed.
 *
 * `resolved` is null when the entry is global and uses the project placeholder:
 * that argv genuinely has no single answer, and inventing one for the review
 * step would approve a line that is never actually run.
 */
function resolvedCommand(s: { transport: 'stdio' | 'http'; command?: string; args?: string; url?: string },
                         projectPath: string | null): { template: string; resolved: string | null } {
  const template = s.transport === 'stdio'
    ? `${s.command ?? ''} ${s.args ?? ''}`.trim()
    : (s.url ?? '');
  if (!template.includes(PROJECT_PATH_SLOT)) return { template, resolved: template };
  return {
    template,
    resolved: projectPath ? template.split(PROJECT_PATH_SLOT).join(projectPath) : null,
  };
}

/**
 * What has to be on screen before a local command becomes a standing grant.
 *
 * An enabled stdio server is not a preference. Wanigan writes it into the
 * config of every session it launches in that scope, and the agent's CLI
 * spawns it — so the click that enables one is the click that authorises a
 * program to run on this machine, repeatedly, unattended. Elsewhere Wanigan
 * makes that kind of grant against a SHA-256 the operator was shown. This is
 * the reading half of the same idea, on the surface that actually has one.
 */
function McpEnableReview({ server, scopeName, scopePath, template, resolved, read, onRead, onCancel, onEnable }: {
  server: McpServerConfig; scopeName: string; scopePath: string | null;
  template: string; resolved: string | null;
  read: boolean; onRead: (next: boolean) => void;
  onCancel: () => void; onEnable: () => void;
}) {
  return (
    <div className="set-review" role="group" aria-label={`Review ${server.name} before enabling it`}>
      <Callout level="warning" title={`Enabling “${server.name}” lets the agent’s CLI run this command at every launch.`}>
        Not once, and not while you are watching: Wanigan writes the line below into the config of
        every session it starts for {scopeName}, and the CLI spawns it. Read the command and its
        arguments the way you would read a line before pasting it into a shell.
      </Callout>

      <dl className="set-facts">
        <div>
          <dt>Command as stored</dt>
          <dd className="set-path set-wrap">{template || '—'}</dd>
        </div>
        <div>
          <dt>Command as it will run</dt>
          <dd className="set-path set-wrap">
            {resolved ?? (
              <span className="dim" style={{ fontFamily: 'inherit' }}>
                This entry is global and uses <span className="mono">{PROJECT_PATH_SLOT}</span>, so the
                argument list differs per repository and there is no single line to show. Scope it to
                one project to see the exact one.
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>
            {server.projectId === null
              ? 'Every project — every session Wanigan launches, in every repository.'
              : `${scopeName} only.`}
            {scopePath && <div className="faint set-path set-wrap">{scopePath}</div>}
          </dd>
        </div>
        <div>
          <dt>Arguments</dt>
          <dd className="set-path set-wrap">{server.args?.trim() || <span className="dim" style={{ fontFamily: 'inherit' }}>none</span>}</dd>
        </div>
      </dl>

      <div style={{ marginTop: 11 }}>
        <Callout level="warning" title="Read and write are decided by the tool’s name, not by what the call did.">
          The policy gate matches each tool name against a list of read verbs — get, list, read,
          search, fetch and their siblings. Nothing observes what an MCP tool actually changed, so a
          server is free to call a mutating tool <span className="mono">get_everything</span> and have
          it allowed without asking at read-only trust. Trust levels bound this server less than they
          appear to. Judge it on the command above, not on the trust level of the project.
        </Callout>
      </div>

      <label className="set-read-check">
        <input type="checkbox" checked={read} onChange={(e) => onRead(e.target.checked)} />
        <span>
          I have read the command, arguments and scope above and want them run at every session
          launch in this scope.
        </span>
      </label>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 11, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" disabled={!read} onClick={onEnable}>
          Enable {server.name}
        </button>
        <button className="btn" onClick={onCancel}>Leave it off</button>
      </div>

      <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 9, lineHeight: 1.55 }}>
        Reading is not the same act as approving. Wanigan records approval of an exact command line
        separately — bound to a digest of the command, arguments and scope, so editing a server drops
        its approval rather than silently changing what gets spawned. If the enable is refused below,
        that record is what is missing, and the refusal names it.
      </p>
    </div>
  );
}

function Mcp({ projects, prefs, pending, setFlag }: {
  projects: Project[]; prefs: WaniganSettings | null; pending: string | null;
  setFlag: (k: string, on: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  // Which server's command line is open for reading. Enabling a stdio server is
  // a standing grant to execute that line at every launch, so the line is put
  // on screen before the click that grants it, never in a tooltip afterwards.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [read, setRead] = useState(false);

  const own = useLoad(() => window.wanigan.mcp.server(), [prefs?.mcpServerEnabled]);
  // Configuration only, no status. There were Connection and Calls columns here
  // reading mcp_status, and nothing in the app has ever written that table —
  // registry.ts's noteConnection and noteToolCall have no callers — so every
  // server read “not seen yet” with zero calls, permanently, which is a false
  // negative wearing the clothes of a measurement. The table and its writers are
  // left alone for whoever wires them up; only the display is gone.
  const servers = useLoad(() => window.wanigan.mcp.servers(), [tick]);

  const projectName = (id: string | null) =>
    id === null ? 'every project' : projects.find((p) => p.id === id)?.name ?? 'a project Wanigan no longer has';

  async function submit() {
    if (!draft) return;
    setSaved(null);
    try {
      const cfg: Omit<McpServerConfig, 'id'> & { id?: string } = {
        id: draft.id,
        projectId: draft.projectId || null,
        name: draft.name.trim(),
        transport: draft.transport,
        command: draft.transport === 'stdio' ? draft.command.trim() : undefined,
        args: draft.transport === 'stdio' ? draft.args.trim() : undefined,
        url: draft.transport === 'http' ? draft.url.trim() : undefined,
        enabled: draft.enabled,
      };
      const r = await window.wanigan.mcp.upsert(cfg);
      setDraft(null);
      setTick((t) => t + 1);
      setSaved({ tone: 'ok', text: `“${r.name}” saved for ${projectName(r.projectId)}. New sessions there get it; sessions already running keep the config they launched with.` });
    } catch (e) { setSaved({ tone: 'error', text: msg(e) }); }
  }

  async function toggleServer(s: McpServerConfig, on: boolean) {
    setSaved(null);
    try {
      await window.wanigan.mcp.upsert({ ...s, enabled: on });
      setTick((t) => t + 1);
      setReviewing(null);
      setSaved({
        tone: 'ok',
        text: on
          ? `“${s.name}” is enabled. Sessions Wanigan launches for ${projectName(s.projectId)} from now on receive it; sessions already running keep the config they launched with.`
          : `“${s.name}” is disabled. It is left out of every config Wanigan writes from now on; a session already running keeps it until it ends.`,
      });
    } catch (e) { setSaved({ tone: 'error', text: msg(e) }); }
  }

  /** Disabling is always allowed. Enabling a local command is read first. */
  function requestEnable(s: McpServerConfig, on: boolean) {
    setSaved(null);
    if (!on || s.transport !== 'stdio') { void toggleServer(s, on); return; }
    setRead(false);
    setReviewing(reviewing === s.id ? null : s.id);
  }

  async function remove(s: McpServerConfig) {
    setSaved(null);
    try {
      await window.wanigan.mcp.remove(s.id);
      setTick((t) => t + 1);
      setSaved({ tone: 'ok', text: `“${s.name}” removed. It stays in any session already running until that session ends.` });
    } catch (e) { setSaved({ tone: 'error', text: msg(e) }); }
  }

  return (
    <Section title="MCP servers"
             hint="Tool servers an agent can call, and Wanigan's own server, which lets an agent call Wanigan back."
             right={!draft && <button className="btn" onClick={() => setDraft(BLANK)}>+ Add server</button>}>

      <div className="set-sub">Wanigan's own MCP server</div>
      <Callout level="warning" title="Turning this on lets compatible sessions use Wanigan tools.">
        New Claude-compatible sessions receive Goal tools for reading their assigned Goal and recording
        their own checkpoints. They cannot update another session’s Goal. The same local server can
        build and queue a batch run against your Claude Platform key. <strong>Submission always stops
        for a human.</strong> Wanigan raises a system dialog naming the run and its estimated cost, and
        nothing reaches the API until you press Submit — a model asking is never enough, and a batch
        cannot be un-submitted. The server binds to loopback with a bearer token minted at launch, so
        only a process on this machine that Wanigan handed the token to can reach it.
      </Callout>

      {prefs && (
        <div style={{ marginTop: 4 }}>
          <Toggle title="Enable Wanigan's MCP server" on={prefs.mcpServerEnabled} busy={pending === 'mcp_server'}
                  onChange={(v) => void setFlag('mcp_server', v)}>
            Off by default. The port is bound once, when Wanigan starts, so switching this on takes
            effect at the next launch. New compatible sessions can then read their assigned Goal,
            record a checkpoint, inspect runs, and prepare a submission for you to approve.
          </Toggle>
        </div>
      )}

      <Frame v={own.v} what="Wanigan's MCP server" onRetry={own.reload}>
        {(info) => info ? (
          <div className="sunk" style={{ padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
              <Mark glyph="✓" word="listening" color="var(--good)" />
              <code className="set-path" style={{ userSelect: 'all' }}>{info.url}</code>
              <button className="set-mini" style={{ marginLeft: 'auto' }}
                      onClick={() => { void navigator.clipboard.writeText(info.url); setSaved({ tone: 'ok', text: 'URL copied. The bearer token is separate and is not shown here.' }); }}>
                copy URL
              </button>
            </div>
            <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.55 }}>
              Streamable HTTP. The port changes every launch, so re-copy it after a restart. The bearer
              token is deliberately not displayed in this window — Wanigan passes it to sessions it
              launches itself.
            </p>
          </div>
        ) : (
          <div className="sunk set-empty">
            {prefs?.mcpServerEnabled
              ? 'Enabled, but nothing is bound yet — the port opens when Wanigan starts. Restart to bring it up; if it still fails, something else holds the port named in WANIGAN_MCP_PORT.'
              : 'Not running. Nothing is bound and no agent can reach Wanigan.'}
          </div>
        )}
      </Frame>

      <div className="set-sub">Servers given to agents</div>
      {draft && (
        <div className="sunk" style={{ padding: '12px 13px', marginBottom: 11 }}>
          <div className="label" style={{ marginBottom: 8 }}>{draft.id ? 'Edit server' : 'New server'}</div>
          <div className="row2">
            <div>
              <label className="label" htmlFor="mcp-name">Name</label>
              <input id="mcp-name" className="field mono" style={{ marginTop: 4 }} value={draft.name}
                     placeholder="playwright" spellCheck={false}
                     onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 4, lineHeight: 1.45 }}>
                Letters, digits, dashes and underscores. It becomes part of the tool id the agent
                calls, so spaces and dots break it.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="mcp-scope">Scope</label>
              <select id="mcp-scope" className="field" style={{ marginTop: 4 }} value={draft.projectId}
                      onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}>
                <option value="">Every project (global)</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 4, lineHeight: 1.45 }}>
                A project-scoped server is added on top of the global ones, not instead of them.
              </p>
            </div>
          </div>

          <div style={{ marginTop: 11 }}>
            <span className="label">Transport</span>
            <div className="set-chips" role="group" aria-label="Transport" style={{ marginTop: 5 }}>
              <button className={`set-chip${draft.transport === 'stdio' ? ' on' : ''}`} aria-pressed={draft.transport === 'stdio'}
                      onClick={() => setDraft({ ...draft, transport: 'stdio' })}>stdio — launch a process</button>
              <button className={`set-chip${draft.transport === 'http' ? ' on' : ''}`} aria-pressed={draft.transport === 'http'}
                      onClick={() => setDraft({ ...draft, transport: 'http' })}>http — call an endpoint</button>
            </div>
          </div>

          {draft.transport === 'stdio' ? (
            <div className="row2" style={{ marginTop: 11 }}>
              <div>
                <label className="label" htmlFor="mcp-cmd">Command</label>
                <input id="mcp-cmd" className="field mono" style={{ marginTop: 4 }} value={draft.command}
                       placeholder="npx" spellCheck={false}
                       onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="mcp-args">Arguments</label>
                <input id="mcp-args" className="field mono" style={{ marginTop: 4 }} value={draft.args}
                       placeholder="-y @modelcontextprotocol/server-filesystem {{PROJECT_PATH}}" spellCheck={false}
                       onChange={(e) => setDraft({ ...draft, args: e.target.value })} />
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 11 }}>
              <label className="label" htmlFor="mcp-url">URL</label>
              <input id="mcp-url" className="field mono" style={{ marginTop: 4 }} value={draft.url}
                     placeholder="https://example.com/mcp" spellCheck={false}
                     onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
            </div>
          )}

          <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 8, lineHeight: 1.5 }}>
            <span className="mono">{'{{PROJECT_PATH}}'}</span> is replaced with the project directory
            when the config is written, so one entry can serve every repo.
          </p>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            <button className="btn btn-primary" onClick={submit} disabled={!draft.name.trim()}>
              {draft.id ? 'Save changes' : 'Add server'}
            </button>
            <button className="btn" onClick={() => { setDraft(null); setSaved(null); }}>Cancel</button>
            {draft.transport === 'http' ? (
              <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--t-small)' }}>
                <input type="checkbox" checked={draft.enabled}
                       onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                Give it to new sessions
              </label>
            ) : (
              <span className="faint" style={{ marginLeft: 'auto', fontSize: 'var(--t-micro)', maxWidth: 320, lineHeight: 1.45 }}>
                Saving a stdio server does not switch it on. Enable it from the list below, where the
                command that will be executed is shown before the grant is made.
              </span>
            )}
          </div>
        </div>
      )}

      <Frame v={servers.v} what="the MCP server list" onRetry={servers.reload}>
        {(list) => {
          if (!list.length) {
            return (
              <div className="sunk set-empty">
                No MCP servers configured, so agents get only their built-in tools.
                <div className="faint" style={{ marginTop: 6, fontSize: 'var(--t-small)' }}>
                  Add one and Wanigan writes it into the config of every session it launches for that scope.
                </div>
                <div style={{ marginTop: 9 }}>
                  <button className="btn" onClick={() => setDraft(BLANK)}>+ Add server</button>
                </div>
              </div>
            );
          }
          return (
            <div className="set-scroll wide">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Name</th><th>Scope</th><th>Target</th><th>Given out</th><th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => {
                    const scopePath = s.projectId ? projects.find((p) => p.id === s.projectId)?.path ?? null : null;
                    const line = resolvedCommand(s, scopePath);
                    return (
                      <Fragment key={s.id}>
                        <tr>
                          <td className="mono" style={{ fontSize: 'var(--t-small)' }}>{s.name}</td>
                          <td className="dim">
                            {s.projectId === null ? 'global' : projectName(s.projectId)}
                            <div className="faint set-sub-line">{s.transport}</div>
                          </td>
                          {/* The command was a tooltip on a truncated cell — the
                              one fact a reviewer needs, in the one place a touch
                              screen cannot reach. It wraps now. */}
                          <td className="set-path set-wrap" style={{ maxWidth: 260 }}>{line.template || '—'}</td>
                          <td>
                            <button className="set-mini" aria-pressed={s.enabled}
                                    aria-expanded={reviewing === s.id}
                                    onClick={() => requestEnable(s, !s.enabled)}>
                              <Mark {...(s.enabled ? ON : OFF)} />
                            </button>
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button className="set-mini" onClick={() => setDraft({
                              id: s.id, name: s.name, projectId: s.projectId ?? '', transport: s.transport,
                              command: s.command ?? '', args: s.args ?? '', url: s.url ?? '', enabled: s.enabled,
                            })}>edit</button>
                            <button className="set-mini danger" onClick={() => void remove(s)}>remove</button>
                          </td>
                        </tr>
                        {reviewing === s.id && (
                          <tr>
                            <td colSpan={5} style={{ padding: 0 }}>
                              <McpEnableReview
                                server={s} scopeName={projectName(s.projectId)} scopePath={scopePath}
                                template={line.template} resolved={line.resolved}
                                read={read} onRead={setRead}
                                onCancel={() => setReviewing(null)}
                                onEnable={() => void toggleServer(s, true)}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        }}
      </Frame>
      <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.5 }}>
        Wanigan writes these into the config of each session it launches and does not watch them
        afterwards. Whether a server answered is between the agent and that server, and this page will
        not guess: it reports what was handed out, not what connected.
      </p>
      <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 6, lineHeight: 1.5 }}>
        Enabling a stdio server requires a recorded approval of that exact command, arguments and
        scope — the same separation of <em>trusted</em> from <em>enabled</em> that provider packs use.
        A server saved before that rule existed carries no approval, so it is left out of the configs
        Wanigan writes until one is made; switching it on here surfaces the refusal rather than
        failing quietly. HTTP servers run no local command and need no approval.
      </p>

      <Result r={saved} />
    </Section>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   5 · Worktrees
   ════════════════════════════════════════════════════════════════════════ */

function Worktrees() {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const orphans = useLoad(() => window.wanigan.worktrees.orphans(), [tick]);

  async function remove(w: WorktreeInfo, force: boolean) {
    setSaved(null); setConfirm(null);
    try {
      const r = await window.wanigan.worktrees.remove(w.path, force);
      setSaved({ tone: r.removed ? 'ok' : 'error', text: r.detail });
      setTick((t) => t + 1);
    } catch (e) { setSaved({ tone: 'error', text: msg(e) }); }
  }

  return (
    <Section title="Worktrees"
             hint="Isolated checkouts Wanigan made so parallel agents stop overwriting each other. One that outlives its session is listed here rather than hidden."
             right={<button className="btn" onClick={() => setTick((t) => t + 1)}>Re-scan</button>}>
      <Frame v={orphans.v} what="the worktree list" onRetry={orphans.reload}>
        {(list) => {
          if (!list.length) {
            return (
              <Note tone="ok">
                <strong>✓ No orphaned worktrees.</strong> Every worktree on disk belongs to a session
                Wanigan knows about.
              </Note>
            );
          }
          return (
            <>
              <Callout level="warning"
                       title={`${plural(list.length, 'worktree')} on disk with no session behind ${list.length === 1 ? 'it' : 'them'}.`}>
                A stale worktree keeps a full checkout on disk forever and holds its branch checked
                out, so nothing else can use that branch. They usually come from a crash or a force
                quit. Removing one deletes the directory; it does not touch the branch's commits.
              </Callout>

              <div className="set-scroll wide" style={{ marginTop: 11 }}>
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Worktree</th><th>Branch</th>
                      <th className="r">Uncommitted</th><th className="r">Ahead</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((w) => {
                      const risky = w.dirty > 0 || w.ahead > 0;
                      const asking = confirm === w.path;
                      return (
                        <tr key={w.path}>
                          <td>
                            <div className="set-path">{fileName(w.path)}</div>
                            {/* The full path decides whether this is the
                                worktree you meant to delete; it was a hover. */}
                            <div className="faint set-path set-wrap">{w.path}</div>
                            <div className="faint set-sub-line">in {w.repoRoot}</div>
                          </td>
                          <td className="mono" style={{ fontSize: 'var(--t-small)' }}>
                            {w.branch ?? <span className="faint">detached</span>}
                            {w.head && <div className="faint" style={{ fontSize: 'var(--t-micro)' }}>{w.head.slice(0, 8)}</div>}
                          </td>
                          <td className="set-n">
                            {w.dirty > 0
                              ? <span style={{ color: 'var(--warning)' }}>{plural(w.dirty, 'file')}</span>
                              : <span className="faint">none</span>}
                          </td>
                          <td className="set-n">
                            {w.ahead > 0
                              ? <span style={{ color: 'var(--warning)' }}>{plural(w.ahead, 'commit')}</span>
                              : <span className="faint">none</span>}
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {asking ? (
                              <>
                                <span className="faint" style={{ fontSize: 'var(--t-micro)', marginRight: 6 }}>
                                  destroy {w.dirty > 0 ? plural(w.dirty, 'uncommitted file') : 'it'}
                                  {w.ahead > 0 ? ` and ${plural(w.ahead, 'unpushed commit')}` : ''}?
                                </span>
                                <button className="set-mini danger" onClick={() => void remove(w, true)}>yes, delete</button>
                                <button className="set-mini" onClick={() => setConfirm(null)}>keep</button>
                              </>
                            ) : (
                              <button className="set-mini danger"
                                      onClick={() => (risky ? setConfirm(w.path) : void remove(w, false))}>
                                remove
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.5 }}>
                A worktree with uncommitted files or unpushed commits asks before it goes — that work
                exists nowhere else.
              </p>
            </>
          );
        }}
      </Frame>
      <Result r={saved} />
    </Section>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   6 · Appearance and motion
   ════════════════════════════════════════════════════════════════════════ */

function Appearance({ preference, resolved, onChange }: {
  preference: ThemeSetting;
  resolved: ResolvedTheme;
  onChange: (preference: ThemeSetting) => Promise<ThemeSetting>;
}) {
  return (
    <Section title="Appearance"
             hint="Choose a colour mode once. It stays local to Wanigan and changes the whole working surface, including code and terminals.">
      <div className="set-appearance">
        <div>
          <h3>Colour mode</h3>
          <p>
            System follows your Mac’s Light/Dark appearance as it changes. Light and Dark stay fixed
            until you choose System again.
          </p>
        </div>
        <ThemeControl variant="card" preference={preference} resolved={resolved} onChange={onChange} />
      </div>
      <p className="faint set-appearance-note">
        This is saved on this Mac. Your paired iPad/phone view uses the same mode after it refreshes,
        so the control surface remains readable when you move between devices.
      </p>
    </Section>
  );
}

function Motion({ prefs, pending, setPref }: {
  prefs: WaniganSettings | null; pending: string | null; setPref: (k: string, v: string) => Promise<void>;
}) {
  return (
    <Section title="Motion"
             hint="Sparklines, the attention strip and the timeline animate as work moves. This decides whether they do.">
      {!prefs ? (
        <p className="dim" style={{ fontSize: 'var(--t-small)' }}>Reading your preferences…</p>
      ) : (
        <>
          <fieldset disabled={pending === 'motion'} style={{ border: 'none' }}>
            <Options<MotionSetting>
              label="Motion"
              value={prefs.motion}
              options={[
                { id: 'auto', word: 'Auto', detail: 'Follow the system. macOS Reduce Motion switches animation off; otherwise it plays. The right answer for almost everyone.' },
                { id: 'full', word: 'Full', detail: 'Always animate, even when the system asks for reduced motion. Use this when you want the movement and the OS setting is there for something else.' },
                { id: 'off',  word: 'Off',  detail: 'Never animate, even when the system allows it. Values still update — they change without sliding.' },
              ]}
              onPick={(v) => void setPref('motion', v)}
            />
          </fieldset>
          <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 8, lineHeight: 1.5 }}>
            This page honours the setting as soon as you pick it — the switches above stop sliding.
            Motion never carries meaning anywhere in Wanigan, so turning it off costs you nothing but
            the movement.
          </p>
        </>
      )}
    </Section>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   7 · Storage
   ════════════════════════════════════════════════════════════════════════ */

function Storage({ prefs, pending, setPref }: {
  prefs: WaniganSettings | null; pending: string | null; setPref: (k: string, v: string) => Promise<void>;
}) {
  const [saved, setSaved] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const [days, setDays] = useState('');
  const [showAll, setShowAll] = useState(false);

  const store = useLoad(async () => {
    const [transcripts, uploads] = await Promise.all([
      window.wanigan.transcripts.list(),
      window.wanigan.uploads.list(),
    ]);
    return { transcripts, uploads };
  }, [tick]);

  useEffect(() => { if (prefs && days === '') setDays(String(prefs.eventRetentionDays)); }, [prefs, days]);

  async function forget(sessionId: string, size: number) {
    setSaved(null);
    try {
      await window.wanigan.transcripts.forget(sessionId);
      setTick((t) => t + 1);
      setSaved({ tone: 'ok', text: `Transcript deleted — ${bytes(size)} reclaimed. The session's costs and events are untouched; only the conversation text is gone.` });
    } catch (e) { setSaved({ tone: 'error', text: msg(e) }); }
  }

  async function dropUpload(f: UploadedFile) {
    setSaved(null);
    try {
      await window.wanigan.uploads.remove(f.hash);
      setTick((t) => t + 1);
      setSaved({ tone: 'ok', text: `${fileName(f.path)} removed — ${bytes(f.bytes)} reclaimed.` });
    } catch (e) { setSaved({ tone: 'error', text: msg(e) }); }
  }

  async function prune() {
    setSaved(null);
    try {
      const n = await window.wanigan.uploads.prune();
      setTick((t) => t + 1);
      setSaved({
        tone: 'ok',
        text: n > 0
          ? `Pruned ${plural(n, 'file')} that no run referenced any more.`
          : 'Nothing to prune — every uploaded file is still referenced by a run.',
      });
    } catch (e) { setSaved({ tone: 'error', text: msg(e) }); }
  }

  return (
    <Section title="Storage"
             hint="What Wanigan has kept on this machine, and what it takes to get rid of it."
             right={<button className="btn" onClick={() => setTick((t) => t + 1)}>Re-measure</button>}>
      <Frame v={store.v} what="what is on disk" onRetry={store.reload}>
        {({ transcripts, uploads }) => {
          const tBytes = transcripts.reduce((a, t) => a + t.bytes, 0);
          const tTurns = transcripts.reduce((a, t) => a + t.turns, 0);
          const uBytes = uploads.reduce((a, u) => a + u.bytes, 0);
          const sorted = [...transcripts].sort((a, b) => b.bytes - a.bytes);
          const shown = showAll ? sorted : sorted.slice(0, 8);

          return (
            <>
              <div className="row2">
                <Stat label="Archived transcripts" value={bytes(tBytes)}
                      sub={`${plural(transcripts.length, 'session')} · ${plural(tTurns, 'turn')}`} />
                <Stat label="Uploaded batch files" value={bytes(uBytes)}
                      sub={plural(uploads.length, 'file')} />
              </div>

              <div className="set-sub">Transcripts</div>
              {!transcripts.length ? (
                <div className="sunk set-empty">
                  No transcripts archived. Nothing of any conversation is on disk.
                  <div className="faint" style={{ marginTop: 6, fontSize: 'var(--t-small)' }}>
                    {prefs?.archiveTranscripts
                      ? 'Archiving is on, so the next session that finishes will appear here.'
                      : 'Archiving is off in Observation above, so none will be written.'}
                  </div>
                </div>
              ) : (
                <>
                  <div className="set-scroll">
                    <table className="grid">
                      <thead>
                        <tr>
                          <th>Session</th><th className="r">Turns</th><th className="r">Size</th>
                          <th>Archived</th><th />
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((t) => (
                          <tr key={t.sessionId}>
                            <td className="set-path set-wrap" style={{ maxWidth: 240 }}>{t.sessionId}</td>
                            <td className="set-n">{num(t.turns)}</td>
                            <td className="set-n">{bytes(t.bytes)}</td>
                            <td className="set-when">
                              {ago(t.archivedAt)}
                              <div className="faint set-sub-line">{fullDate(t.archivedAt)}</div>
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <button className="set-mini danger" onClick={() => void forget(t.sessionId, t.bytes)}>
                                forget
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {sorted.length > shown.length && (
                    <button className="set-mini" style={{ marginTop: 7 }} onClick={() => setShowAll(true)}>
                      show the other {num(sorted.length - shown.length)} — largest first
                    </button>
                  )}
                  <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.5 }}>
                    Largest first, because that is the order you would delete in. Forgetting a
                    transcript removes the conversation text and the search index for it; the
                    session's cost and event history stay.
                  </p>
                </>
              )}

              <div className="set-sub">Uploaded batch files</div>
              {!uploads.length ? (
                <div className="sunk set-empty">
                  No files uploaded. Batch runs that reference files put a copy here so the same bytes
                  are not sent twice.
                </div>
              ) : (
                <>
                  <div className="set-scroll">
                    <table className="grid">
                      <thead>
                        <tr><th>File</th><th>Type</th><th className="r">Size</th><th>Uploaded</th><th /></tr>
                      </thead>
                      <tbody>
                        {[...uploads].sort((a, b) => b.bytes - a.bytes).map((u) => (
                          <tr key={u.hash}>
                            <td style={{ maxWidth: 260 }}>
                              {fileName(u.path)}
                              <div className="faint set-path set-wrap">{u.path}</div>
                            </td>
                            <td className="dim mono" style={{ fontSize: 'var(--t-micro)' }}>{u.mediaType}</td>
                            <td className="set-n">{bytes(u.bytes)}</td>
                            <td className="set-when">
                              {ago(u.uploadedAt)}
                              <div className="faint set-sub-line">{fullDate(u.uploadedAt)}</div>
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <button className="set-mini danger" onClick={() => void dropUpload(u)}>remove</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button className="btn" style={{ marginTop: 9 }} onClick={prune}>Prune unreferenced files</button>
                </>
              )}

              <div className="set-sub">Session attachment directories</div>
              <div className="sunk" style={{ padding: '11px 13px' }}>
                <p className="dim" style={{ fontSize: 'var(--t-small)', lineHeight: 1.55 }}>
                  Each session gets a directory that starts as an attachment staging area and stays
                  the agent’s only writable non-project location, so reports and generated images
                  linked from a saved conversation live there too. It is deliberately kept when the
                  session exits — deleting it would turn an intact conversation into a page of dead
                  links — which means the tree only grows.
                </p>
                <p className="dim" style={{ fontSize: 'var(--t-small)', lineHeight: 1.55, marginTop: 7 }}>
                  <strong>This screen cannot yet measure or reclaim it.</strong> The two figures above
                  cover transcripts and uploaded batch files only, so they are not the size of
                  Wanigan’s data directory. Until an age-based retention control reaches this panel,
                  the honest answer is that these directories are not listed here and nothing in the
                  app removes them.
                </p>
              </div>
            </>
          );
        }}
      </Frame>

      <div className="set-sub">Event retention</div>
      <div className="set-row" style={{ borderTop: 'none', paddingTop: 0 }}>
        <div className="txt">
          <h4>How long hook events are kept</h4>
          <p>
            A busy session writes thousands of tool events. This is the window Wanigan keeps them for;
            the timeline and the tool statistics read no further back than this. It does not touch
            transcripts, costs or the policy ledger — those have their own controls.
          </p>
        </div>
        <div style={{ flex: 'none', display: 'flex', gap: 7, alignItems: 'center' }}>
          <input className="field mono" type="number" min={1} max={3650} style={{ width: 84, textAlign: 'right' }}
                 aria-label="Event retention in days" value={days}
                 onChange={(e) => setDays(e.target.value)} />
          <span className="faint" style={{ fontSize: 'var(--t-small)' }}>days</span>
          <button className="btn" disabled={pending === 'event_retention_days' || !days.trim()}
                  onClick={async () => {
                    const n = Math.max(1, Math.round(Number(days) || 0));
                    setDays(String(n));
                    await setPref('event_retention_days', String(n));
                    setSaved({ tone: 'ok', text: `Hook events are kept for ${plural(n, 'day')}.` });
                  }}>Save</button>
        </div>
      </div>

      <Result r={saved} />
    </Section>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   8 · Reading the transcript archive
   ════════════════════════════════════════════════════════════════════════ */

/*
 * The markers main wraps around a match.
 *
 * They are a copy of HIT_OPEN/HIT_CLOSE in src/main/transcripts.ts, which the
 * renderer cannot import. The pair was chosen there precisely so a renderer
 * could swap them for markup without corrupting a snippet that quotes a bracket
 * or a tag — so the copy is the contract, and if that file ever changes them,
 * highlighting here degrades to showing the raw characters rather than to
 * showing something false. Putting them in shared/types is the right fix and
 * belongs in that file.
 */
const HIT_OPEN = '«';
const HIT_CLOSE = '»';

function Snippet({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  for (;;) {
    const open = rest.indexOf(HIT_OPEN);
    const close = open < 0 ? -1 : rest.indexOf(HIT_CLOSE, open + 1);
    if (open < 0 || close < 0) break;
    if (open > 0) parts.push(rest.slice(0, open));
    parts.push(<mark key={`m${key++}`} className="set-hit">{rest.slice(open + 1, close)}</mark>);
    rest = rest.slice(close + 1);
  }
  if (rest) parts.push(rest);
  return <>{parts}</>;
}

const TURN_ROLE: Record<TranscriptTurn['role'], string> = {
  user: 'You', assistant: 'Agent', system: 'System', tool: 'Tool',
};

/** Rendered before the "show the rest" button; the rest is one click away. */
const READER_TURN_CAP = 200;

/** The whole archived conversation, read on demand rather than with the hits. */
function TranscriptReader({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const doc = useLoad(() => window.wanigan.transcripts.get(sessionId), [sessionId]);
  const [all, setAll] = useState(false);

  return (
    <div className="set-reader">
      <div className="set-reader-head">
        <div>
          <div className="label">Archived conversation</div>
          <div className="set-path set-wrap">{sessionId}</div>
        </div>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      <Frame v={doc.v} what="this transcript" onRetry={doc.reload}>
        {(d) => {
          if (!d.turns.length) {
            return (
              <div className="sunk set-empty">
                The archive holds {bytes(d.bytes)} for this session but no readable turns.
                {d.note && <div className="faint" style={{ marginTop: 6, fontSize: 'var(--t-small)' }}>{d.note}</div>}
              </div>
            );
          }
          const shown = all ? d.turns : d.turns.slice(0, READER_TURN_CAP);
          return (
            <>
              <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.5, marginBottom: 8 }}>
                {plural(d.turns.length, 'turn')} · {bytes(d.bytes)} on this disk. Oldest first, so the
                end of the conversation is at the bottom.
                {d.note ? ` ${d.note}` : ''}
              </p>
              <div className="set-turns">
                {shown.map((t, i) => (
                  <article key={`${t.at}-${i}`} className="set-turn" data-role={t.role}>
                    <header>
                      <strong>{TURN_ROLE[t.role]}</strong>
                      {t.toolName && <span className="mono faint"> · {t.toolName}</span>}
                      <span className="faint set-sub-line"> {fullDate(t.at)}</span>
                    </header>
                    <pre>{t.text}</pre>
                  </article>
                ))}
              </div>
              {d.turns.length > shown.length && (
                <button className="btn" style={{ marginTop: 9 }} onClick={() => setAll(true)}>
                  Show the remaining {num(d.turns.length - shown.length)} turns
                </button>
              )}
            </>
          );
        }}
      </Frame>
    </div>
  );
}

/**
 * The archive has had an FTS5 index and a working search since it was built,
 * and no reader at all: the only transcript surface was a storage list with a
 * forget button, so the delete verb was reachable and the search verb was not.
 * This is the question that gets asked in an incident — "that session did
 * something odd, what did it actually say" — and it had no answer.
 */
function TranscriptSearch({ prefs }: { prefs: WaniganSettings | null }) {
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const hits = useLoad<TranscriptHit[]>(
    async () => (query.trim() ? window.wanigan.transcripts.search(query.trim(), 80) : []),
    [query],
  );

  function run() {
    setOpen(null);
    setQuery(typed);
  }

  return (
    <Section title="Search transcripts"
             hint="Full-text search across every conversation Wanigan has archived on this machine. Nothing is sent anywhere to answer it.">
      <form className="set-field-action" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <label className="sr-only" htmlFor="transcript-q">Search archived transcripts</label>
        <input id="transcript-q" className="field" value={typed} spellCheck={false}
               placeholder="rm -rf, .env, force push, a file name…"
               onChange={(e) => setTyped(e.target.value)} />
        <button className="btn btn-primary" type="submit" disabled={!typed.trim()}>Search</button>
      </form>
      <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 5, lineHeight: 1.5 }}>
        Matches user and agent turns. Only sessions archived while <em>Archive transcripts</em> was on
        are here — {prefs
          ? prefs.archiveTranscripts
            ? 'it is on now, so sessions that finish from here on are searchable.'
            : 'it is off now, so nothing new is being added.'
          : 'that switch is still loading.'}
      </p>

      {!query.trim() ? (
        <div className="sunk set-empty" style={{ marginTop: 11 }}>
          Type something to search for. Nothing has been read yet.
        </div>
      ) : (
        <div style={{ marginTop: 11 }}>
          <Frame v={hits.v} what="the transcript index" onRetry={hits.reload}>
            {(rows) => {
              if (!rows.length) {
                return (
                  <div className="sunk set-empty">
                    No archived turn contains “{query.trim()}”.
                    <div className="faint" style={{ marginTop: 6, fontSize: 'var(--t-small)' }}>
                      That is an answer about the archive, not about what the agents did: a session
                      that ran while archiving was off left no text to search, and a forgotten
                      transcript is gone from the index too.
                    </div>
                  </div>
                );
              }
              return (
                <>
                  <div className="set-scroll wide">
                    <table className="grid">
                      <thead>
                        <tr><th>When</th><th>Project</th><th>Who</th><th>Match</th><th /></tr>
                      </thead>
                      <tbody>
                        {rows.map((h, i) => (
                          <tr key={`${h.sessionId}-${h.at}-${i}`}>
                            <td className="set-when">
                              {ago(h.at)}
                              <div className="faint set-sub-line">{fullDate(h.at)}</div>
                            </td>
                            <td>
                              {h.projectName}
                              <div className="faint set-sub-line">
                                {h.providerId || 'provider not recorded'}
                              </div>
                            </td>
                            <td className="dim">{h.role === 'user' ? 'You' : 'Agent'}</td>
                            <td className="dim set-wrap" style={{ maxWidth: 420, lineHeight: 1.5 }}>
                              <Snippet text={h.snippet} />
                            </td>
                            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                              <button className="set-mini"
                                      onClick={() => setOpen(open === h.sessionId ? null : h.sessionId)}>
                                {open === h.sessionId ? 'close' : 'read session'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.5 }}>
                    {plural(rows.length, 'matching turn')}, best match first, capped at 80. A hit names
                    the session so you can open the whole conversation beside it.
                  </p>
                </>
              );
            }}
          </Frame>
          {open && (
            <div style={{ marginTop: 12 }}>
              <TranscriptReader sessionId={open} onClose={() => setOpen(null)} />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   9 · Backup and restore
   ════════════════════════════════════════════════════════════════════════ */

/** Both evidence clocks read the same way, including when there is no clock. */
const evidenceClock = (at: number | null) => (at === null ? 'nothing recorded' : fullDate(at));

/**
 * The database is the source of truth for every Goal, proof, decision and
 * learned item Wanigan holds, and until this section existed there was no
 * export, no copy and no way back: a failed disk or a new laptop took all of it,
 * and the app never said so.
 *
 * Every number this panel prints is measured — bytes written, files copied,
 * digests verified — so none of them carries a tilde. The one thing it will not
 * do is promise that a restore is safe: that is decided by the two evidence
 * clocks, and both are put on screen before the decision, not after it.
 */
type BackupAction = 'create' | 'inspect' | 'restore';

function Backup() {
  const [busy, setBusy] = useState<BackupAction | null>(null);
  const [made, setMade] = useState<BackupSummary | null>(null);
  const [checked, setChecked] = useState<BackupCheck | null>(null);
  const [restored, setRestored] = useState<BackupRestoreSummary | null>(null);
  // Kept with the action that produced it: a refusal from the restore path must
  // not surface under "Back up now", where it would read as a failed backup.
  const [note, setNote] = useState<{ kind: BackupAction; tone: 'info' | 'error'; text: string } | null>(null);

  async function run<T>(kind: BackupAction, fn: () => Promise<T | null>,
                        onDone: (value: T) => void, canceledText: string) {
    setBusy(kind); setNote(null);
    try {
      const value = await fn();
      // A native chooser that was dismissed returns null. That is a decision,
      // not a failure, and it does not deserve red.
      if (value === null) { setNote({ kind, tone: 'info', text: canceledText }); return; }
      onDone(value);
    } catch (e) {
      setNote({ kind, tone: 'error', text: msg(e) });
    } finally { setBusy(null); }
  }

  const outcome = (kind: BackupAction) => (note && note.kind === kind ? (
    <div style={{ marginTop: 11 }}>
      {note.tone === 'error'
        ? (
          <Callout level="critical" title="Nothing was changed.">
            <p className="set-wrap" style={{ whiteSpace: 'pre-wrap' }}>{note.text}</p>
          </Callout>
        )
        : <Note tone="info">{note.text}</Note>}
    </div>
  ) : null);

  return (
    <>
      <Section title="Back up Wanigan’s record"
               hint="One folder holding a verified copy of the database and every archived transcript. Written where you choose; nothing is uploaded and nothing is scheduled.">
        <Callout level="warning" title="Wanigan takes no backup on its own. Nothing here is scheduled.">
          Its Goals, proofs, decisions, costs, learned items and archived conversations all live in
          one SQLite database on this Mac. A whole-disk backup may happen to carry it; nothing inside
          Wanigan does, and a copy of a live SQLite database is not automatically a consistent one.
          A backup is a deliberate act, and this is the only place in the app to make one.
        </Callout>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={busy !== null}
                  onClick={() => void run('create', () => window.wanigan.backup.create(), (v) => { setMade(v); setChecked(null); }, 'Backup canceled at the folder chooser. Nothing was written.')}>
            {busy === 'create' ? 'Copying…' : 'Back up now'}
          </button>
          <span className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.45, maxWidth: 420 }}>
            You choose the folder. Wanigan writes a consistent copy of the live database, every
            archived transcript, and a manifest carrying a SHA-256 of each file.
          </span>
        </div>

        {made && (
          <div style={{ marginTop: 12 }}>
            <Note tone="ok">Backup written.</Note>
            <div className="set-scroll" style={{ marginTop: 9 }}>
              <table className="grid">
                <thead><tr><th>What was written</th><th>Measured</th></tr></thead>
                <tbody>
                  <tr>
                    <td>Folder</td>
                    <td className="set-path set-wrap" style={{ userSelect: 'all' }}>{made.dir}</td>
                  </tr>
                  <tr>
                    <td>Total on disk</td>
                    <td>{bytes(made.totalBytes)} across the database, the transcripts and the manifest</td>
                  </tr>
                  <tr>
                    <td>Database</td>
                    <td>
                      {bytes(made.database.bytes)}
                      <div className="faint set-path set-wrap">sha256 {made.database.sha256}</div>
                    </td>
                  </tr>
                  <tr>
                    <td>Transcripts copied</td>
                    <td>{plural(made.transcripts.files, 'file')} · {bytes(made.transcripts.bytes)}</td>
                  </tr>
                  <tr>
                    <td>Newest evidence in the copy</td>
                    <td>{evidenceClock(made.latestEvidenceAt)}</td>
                  </tr>
                  <tr>
                    <td>Time taken</td>
                    <td>{dur(made.durationMs)} · Wanigan {made.appVersion}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {made.excluded.length > 0 && (
              <>
                <div className="set-sub">Deliberately not in the backup</div>
                <ul className="set-list">
                  {made.excluded.map((line) => <li key={line}>{line}</li>)}
                </ul>
              </>
            )}
            <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.5 }}>
              Every figure above was read from the files after they were written, not projected from
              the database’s size. Copy the folder somewhere that is not this machine — a backup on
              the disk that fails is not a backup.
            </p>
          </div>
        )}
        {outcome('create')}
      </Section>

      <Section title="Check a backup"
               hint="Read-only. Verifies a folder against its manifest and says what restoring it would cost, before you decide anything.">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" disabled={busy !== null}
                  onClick={() => void run('inspect', () => window.wanigan.backup.inspect(), (v) => { setChecked(v); setMade(null); }, 'Check canceled at the folder chooser. Nothing was read.')}>
            {busy === 'inspect' ? 'Verifying…' : 'Check a backup folder'}
          </button>
          <span className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.45, maxWidth: 420 }}>
            Nothing is changed by this. It re-hashes the files, compares them with the manifest, and
            compares the backup’s newest evidence with the database in place.
          </span>
        </div>

        {checked && (
          <div style={{ marginTop: 12 }}>
            {checked.problems.length ? (
              <Callout level="critical" title="This backup did not verify. It cannot be restored.">
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {checked.problems.map((p) => <li key={p.code} style={{ marginTop: 4 }}>{p.detail}</li>)}
                </ul>
              </Callout>
            ) : (
              <Note tone="ok">This backup verified: every file matches the digest recorded in its manifest.</Note>
            )}
            <div className="set-scroll" style={{ marginTop: 9 }}>
              <table className="grid">
                <thead><tr><th>Fact</th><th>Value</th></tr></thead>
                <tbody>
                  <tr><td>Folder</td><td className="set-path set-wrap">{checked.dir}</td></tr>
                  <tr><td>Taken</td><td>{checked.createdAt === null ? 'no date recorded' : fullDate(checked.createdAt)}</td></tr>
                  <tr><td>Written by</td><td>{checked.appVersion ?? 'version not recorded'}</td></tr>
                  <tr>
                    <td>Database</td>
                    <td>
                      {checked.database ? bytes(checked.database.bytes) : 'none in this folder'}
                      {checked.database && <div className="faint set-path set-wrap">sha256 {checked.database.sha256}</div>}
                    </td>
                  </tr>
                  <tr><td>Transcripts</td><td>{plural(checked.transcripts.files, 'file')} · {bytes(checked.transcripts.bytes)}</td></tr>
                  <tr><td>Newest evidence in this backup</td><td>{evidenceClock(checked.latestEvidenceAt)}</td></tr>
                  <tr><td>Newest evidence in the database now</td><td>{evidenceClock(checked.currentLatestEvidenceAt)}</td></tr>
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 10 }}>
              {checked.wouldDiscardNewer ? (
                <Callout level="critical" title="The database in place holds work this backup does not.">
                  Restoring would drop everything recorded between the two clocks above. Back up the
                  current database first if any of it matters.
                </Callout>
              ) : (
                <Note tone="info">
                  The database in place records nothing newer than this backup, so restoring it would
                  drop no recorded work.
                </Note>
              )}
            </div>
          </div>
        )}
        {outcome('inspect')}
      </Section>

      <Section title="Restore a backup"
               hint="Replaces the database and the transcript archive in place, then relaunches Wanigan.">
        <Callout level="critical" title="Read this before you start: a restore relaunches Wanigan, and it is refused while any agent is live.">
          <p>
            <strong>Every running agent must be stopped first.</strong> A restore swaps the database
            file out from under this process, and anything still writing to it — a terminal recording
            events, a headless row banking a cost — would start failing against a file that has moved.
            Wanigan counts the live interactive and headless agents and refuses, naming the number,
            rather than starting and hoping.
          </p>
          <p style={{ marginTop: 6 }}>
            <strong>Wanigan restarts immediately afterwards.</strong> The database connection this
            window holds is closed to make the swap, so the app cannot keep running against it. A
            live terminal cannot survive that: saved projects, transcripts and settings are a
            different thing from a running PTY.
          </p>
          <p style={{ marginTop: 6 }}>
            <strong>Nothing is deleted.</strong> The replaced database and transcripts are moved into
            a dated folder inside Wanigan’s data directory, and the restore names it. Your API
            credential and your provider-pack and MCP approvals are <em>not</em> restored — those are
            granted on one machine, for one machine.
          </p>
        </Callout>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-danger" disabled={busy !== null}
                  onClick={() => void run('restore', () => window.wanigan.backup.restore(), setRestored, 'Restore canceled. The database in place was not touched.')}>
            {busy === 'restore' ? 'Restoring…' : 'Choose a backup to restore'}
          </button>
          <span className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.45, maxWidth: 440 }}>
            After you pick a folder, Wanigan verifies it and then asks once more — naming the backup’s
            date, its transcript count, both evidence clocks and where the replaced files will be
            moved. Nothing is replaced until you answer that.
          </span>
        </div>

        {restored && (
          <div style={{ marginTop: 12 }}>
            <Callout level="warning" title="Restored. Wanigan is restarting to open the restored database.">
              This window is already running against a closed connection, so its other panels will
              fail until the app comes back.
            </Callout>
            <div className="set-scroll" style={{ marginTop: 9 }}>
              <table className="grid">
                <thead><tr><th>What happened</th><th>Measured</th></tr></thead>
                <tbody>
                  <tr><td>Restored from</td><td className="set-path set-wrap">{restored.restoredFrom}</td></tr>
                  <tr><td>That backup was taken</td><td>{fullDate(restored.createdAt)}</td></tr>
                  <tr><td>Database put in place</td><td>{bytes(restored.database.bytes)}</td></tr>
                  <tr><td>Transcripts put in place</td><td>{plural(restored.transcripts.files, 'file')} · {bytes(restored.transcripts.bytes)}</td></tr>
                  <tr><td>Replaced files moved to</td><td className="set-path set-wrap">{restored.replacedDir}</td></tr>
                  <tr>
                    <td>Newer work dropped</td>
                    <td>{restored.discardedNewer
                      ? 'Yes — the database in place held work recorded after this backup.'
                      : 'No — the database in place held nothing newer.'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {outcome('restore')}
      </Section>
    </>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Styles

   Settings owns no feature stylesheet: index.css belongs to the shell and each
   styles/*.css belongs to the phase that made it. So the rules this surface
   needs, and only this surface needs, live here, scoped to .set. Not one colour
   is declared — every value is a token from index.css.
   ════════════════════════════════════════════════════════════════════════ */

const SHEET = `
.set :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 5px; }

.set.pane { width: 100%; max-width: none; flex: 1 1 auto; align-self: stretch; min-width: 0; box-sizing: border-box; overscroll-behavior: contain; }
.set-kicker, .set-panel-kicker { color: var(--accent); font-size: 10.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.set-kicker { margin-bottom: 4px; }
.set-hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(270px, .72fr); gap: var(--s-4); align-items: start; }
.set-hero h1 { font-size: var(--t-title); font-weight: 600; letter-spacing: -.015em; }
.set-hero > div > p { max-width: 640px; margin-top: 4px; color: var(--text-dim); font-size: var(--t-small); line-height: 1.5; }
.set-save-guide { padding: 11px 13px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-sunk); color: var(--text-dim); font-size: var(--t-small); line-height: 1.5; }
.set-save-guide strong { display: block; color: var(--text); font-size: 12px; margin-bottom: 3px; }

.set-layout { display: grid; grid-template-columns: clamp(196px, 18vw, 232px) minmax(0, 1fr); gap: var(--s-4); align-items: start; align-self: stretch; min-width: 0; width: 100%; }
.set-tabs { position: sticky; top: 0; display: flex; flex-direction: column; gap: 4px; padding: 7px; max-height: calc(100vh - 104px); overflow-y: auto; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-sunk); scrollbar-width: thin; }
.set-tabs-intro { padding: 5px 6px 8px; color: var(--text-dim); font-size: var(--t-micro); line-height: 1.45; border-bottom: 1px solid var(--line-soft); margin-bottom: 2px; }
.set-tabs-intro strong { display: block; color: var(--text); font-size: 11px; margin-bottom: 2px; }
.set-tabs button { display: grid; gap: 2px; width: 100%; min-height: 48px; padding: 8px 10px; border-radius: 8px; color: var(--text-dim); text-align: left; font-size: 12px; font-weight: 650; touch-action: manipulation; }
.set-tabs button:hover { color: var(--text); background: var(--bg-soft); }
.set-tabs button.on { color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.set-tab-label { line-height: 1.2; }
.set-tab-detail { color: var(--text-faint); font-size: 10.5px; font-weight: 500; line-height: 1.25; }
.set-tabs button.on .set-tab-detail { color: var(--accent); opacity: .82; }
.set-panels { min-width: 0; width: 100%; }
.set-tab-panel { display: flex; flex-direction: column; gap: var(--s-4); min-width: 0; width: 100%; }
.set-tab-panel[hidden] { display: none; }
.set-panel-intro { padding: 14px 15px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-sunk); }
.set-panel-intro h2 { margin-top: 3px; font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
.set-panel-intro > p:not(.set-panel-includes) { margin-top: 4px; color: var(--text-dim); font-size: var(--t-small); line-height: 1.5; }
.set-panel-help { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 8px; margin-top: 12px; padding: 9px 10px; border-radius: 8px; background: var(--bg-soft); color: var(--text-dim); font-size: var(--t-small); line-height: 1.5; }
.set-panel-help-mark { width: 20px; height: 20px; display: grid; place-items: center; border: 1px solid var(--accent); border-radius: 999px; color: var(--accent); font-size: 11px; font-weight: 750; }
.set-panel-help strong { color: var(--text); font-size: 12px; }
.set-panel-help p { margin-top: 2px; }
.set-panel-includes { display: flex; flex-wrap: wrap; gap: 5px 8px; margin-top: 10px; color: var(--text-faint); font-size: var(--t-micro); line-height: 1.45; }
.set-panel-includes strong { color: var(--text-dim); font-size: inherit; }

.set-field-action { display: flex; gap: 7px; align-items: center; margin-top: 4px; }
.set-field-action > .field { min-width: 0; flex: 1; }
.set-field-action > .btn { flex: none; }
.set-key-status { display: flex; gap: 8px 11px; align-items: center; flex-wrap: wrap; margin-bottom: 11px; }
.set-key-status .btn:first-of-type { margin-left: auto; }
.set-runtime-row, .set-project-row { display: flex; gap: 11px; align-items: center; padding: 7px 0; border-top: 1px solid var(--line-soft); min-width: 0; }

/* The motion setting is real on the surface that sets it. */
.set[data-motion='off'] * { transition: none !important; animation: none !important; }
@media (prefers-reduced-motion: reduce) {
  .set[data-motion='auto'] * { transition: none !important; animation: none !important; }
}

/* Wide tables scroll inside themselves. The page body never scrolls sideways. */
.set-scroll { overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; }
.set-scroll > table { min-width: 560px; }
.set-scroll.wide > table { min-width: 700px; }

.set-n { text-align: right; white-space: nowrap;
         font-variant-numeric: tabular-nums;
         font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace; }
.set-when { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--text-dim); }
.set-path { font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace;
            font-size: 11.5px; word-break: break-all; font-variant-numeric: tabular-nums; }

/* Sub-lines under a cell are still digits, so they line up like one. */
.set-sub-line { font-size: 10.5px; font-variant-numeric: tabular-nums; }

/* A mark is glyph + word + colour, in that order of importance. */
.set-mark { display: inline-flex; align-items: center; gap: 5px;
            font-size: 11px; font-weight: 600; white-space: nowrap; }
.set-mark .g { line-height: 1; }

.set-row { display: flex; gap: 16px; align-items: flex-start;
           padding: 11px 2px; border-top: 1px solid var(--line-soft); }
.set-row:first-child { border-top: none; padding-top: 2px; }
.set-row .txt { flex: 1; min-width: 0; }
.set-row h4 { font-size: 12.5px; font-weight: 600; }
.set-row p { font-size: 12px; line-height: 1.5; color: var(--text-dim); margin-top: 3px; }

.set-appearance { display: flex; align-items: center; justify-content: space-between; gap: var(--s-4); padding: 11px 2px; }
.set-appearance > div { min-width: 0; }
.set-appearance h3 { font-size: 12.5px; font-weight: 600; }
.set-appearance p, .set-appearance-note { font-size: var(--t-small); line-height: 1.5; }
.set-appearance p { margin-top: 3px; color: var(--text-dim); max-width: 680px; }
.set-appearance-note { margin-top: 3px; }

.set-switch { flex: none; display: flex; align-items: center; gap: 9px; padding: 3px; border-radius: 8px; }
.set-switch:disabled { opacity: .5; cursor: not-allowed; }
.set-state { width: 42px; text-align: right; font-size: 11px; font-weight: 700; }
.set-track { position: relative; flex: none; width: 34px; height: 19px; border-radius: 999px;
             background: var(--bg-sunk); border: 1px solid var(--line);
             transition: background .12s, border-color .12s; }
.set-switch[aria-checked='true'] .set-track { background: var(--accent-soft); border-color: var(--accent); }
.set-knob { position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 999px;
            background: var(--text-faint); transition: transform .12s, background .12s; }
.set-switch[aria-checked='true'] .set-knob { transform: translateX(15px); background: var(--accent); }

.set-opts { display: grid; gap: 7px; }
.set-opt { display: block; width: 100%; text-align: left; padding: 9px 11px; border-radius: 8px;
           border: 1px solid var(--line); background: var(--bg-sunk);
           transition: border-color .12s, background .12s; }
.set-opt:hover { border-color: var(--text-faint); }
.set-opt.on { border-color: var(--accent); background: var(--accent-soft); }
.set-opt-top { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 650; }
.set-opt .g { color: var(--text-faint); }
.set-opt.on .g { color: var(--accent); }
.set-opt-now { margin-left: auto; font-size: 10px; font-weight: 700; letter-spacing: .07em;
               text-transform: uppercase; color: var(--accent); }
.set-opt-detail { display: block; margin-top: 3px; font-size: 12px; line-height: 1.5; color: var(--text-dim); }

.set-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.set-chip { padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line);
            background: var(--bg-sunk); font-size: 11.5px; font-weight: 500; color: var(--text-dim); }
.set-chip:hover { border-color: var(--text-faint); color: var(--text); }
.set-chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }

.set-meter { height: 6px; border-radius: 3px; overflow: hidden;
             background: var(--bg); border: 1px solid var(--line); }
.set-meter > span { display: block; height: 100%; background: var(--series-1); }

.set-sub { margin: 16px 0 7px; font-size: 10.5px; font-weight: 600;
           letter-spacing: .07em; text-transform: uppercase; color: var(--text-faint); }

/* Text that used to be a title attribute. A tooltip is nothing on a touch
   screen, unreliable in a screen reader and unreachable from a keyboard, so
   anything load-bearing wraps in place instead of hiding behind a hover. */
.set-wrap { white-space: normal; overflow-wrap: anywhere; word-break: break-word; }

/* Visually hidden, still announced and still focusable by a screen reader. */
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
           overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

.set-list { margin: 0; padding-left: 17px; color: var(--text-dim);
            font-size: var(--t-small); line-height: 1.55; }
.set-list li { margin-top: 3px; }

/* Filter bars: one labelled control per fact you can scope by. */
.set-filters { display: flex; flex-wrap: wrap; gap: 9px 11px; align-items: flex-end;
               margin: 12px 0 9px; }
.set-filter-field { display: flex; flex-direction: column; gap: 3px; min-width: 150px; }
.set-filter-field.grow { flex: 1 1 220px; }
.set-filter-field > .field { max-width: 260px; }
.set-filter-field.grow > .field { max-width: none; }
.set-filter-actions { display: flex; gap: 8px; margin-left: auto; align-items: flex-end; flex-wrap: wrap; }

/* A destructive confirmation and a consent review are the same shape: a bordered
   region that is plainly not part of the list it grew out of. */
.set-danger-zone, .set-review { display: grid; gap: 11px; padding: 13px;
                                border-radius: var(--r-md); background: var(--bg-sunk);
                                border: 1px solid var(--line); }
.set-danger-zone { border-color: var(--critical); }
.set-review { margin: 4px 0; }

.set-facts { display: grid; gap: 9px; margin: 0; }
.set-facts > div { display: grid; grid-template-columns: minmax(130px, 170px) minmax(0, 1fr); gap: 10px; }
.set-facts dt { font-size: 11px; font-weight: 650; color: var(--text-dim); }
.set-facts dd { margin: 0; min-width: 0; font-size: var(--t-small); line-height: 1.5; }

.set-read-check { display: flex; gap: 8px; align-items: flex-start; margin-top: 4px;
                  font-size: var(--t-small); line-height: 1.5; color: var(--text); }
.set-read-check input { margin-top: 3px; flex: none; }

/* Transcript search and the reader it opens. */
.set-hit { background: var(--accent-soft); color: var(--accent); border-radius: 3px; padding: 0 2px; }
.set-reader { border: 1px solid var(--line); border-radius: var(--r-md);
              background: var(--bg-sunk); padding: 13px; }
.set-reader-head { display: flex; gap: 11px; align-items: flex-start;
                   justify-content: space-between; margin-bottom: 11px; }
.set-turns { display: grid; gap: 9px; max-height: 520px; overflow-y: auto;
             overscroll-behavior: contain; padding-right: 4px; }
.set-turn { border-left: 2px solid var(--line); padding: 2px 0 2px 10px; }
.set-turn[data-role='user'] { border-left-color: var(--accent); }
.set-turn[data-role='assistant'] { border-left-color: var(--series-1); }
.set-turn header { font-size: 11px; color: var(--text-dim); }
.set-turn header strong { color: var(--text); font-size: 11.5px; }
.set-turn pre { margin-top: 4px; white-space: pre-wrap; overflow-wrap: anywhere;
                font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace;
                font-size: 11.5px; line-height: 1.55; color: var(--text-dim); }

.set-empty { padding: 20px 14px; text-align: center;
             font-size: 12.5px; line-height: 1.55; color: var(--text-dim); }

.set-mini { padding: 2px 7px; border-radius: 6px; font-size: 11px; font-weight: 600; color: var(--text-dim); }
.set-mini:hover { background: var(--bg-sunk); color: var(--text); }
.set-mini.danger:hover { background: var(--critical-soft); color: var(--critical); }

/* A full-width desktop carries a rail. An iPad or a desktop split view gets a
   scrollable touch tab strip instead of a narrow second column. */
@media (max-width: 1024px), (pointer: coarse) and (max-width: 1180px) {
  .set-hero { grid-template-columns: 1fr; gap: 10px; }
  .set-save-guide { max-width: none; }
  .set-layout { display: flex; flex-direction: column; gap: var(--s-4); }
  .set-tabs { position: relative; top: auto; flex-direction: row; width: 100%; max-height: none; overflow-x: auto; overflow-y: hidden; padding: 5px; scroll-padding-inline: 8px; scroll-snap-type: x proximity; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; touch-action: pan-x; }
  .set-tabs-intro { display: none; }
  .set-tabs button { flex: 0 0 auto; width: auto; min-height: 42px; padding: 8px 11px; white-space: nowrap; scroll-snap-align: start; }
  .set-tab-detail { display: none; }
  .set-panels { width: 100%; }
}

@media (pointer: coarse) {
  .set-tabs button, .set-switch, .set-opt { min-height: 44px; touch-action: manipulation; }
  .set-mini, .set-chip { min-height: 40px; padding-inline: 10px; touch-action: manipulation; }
  .set button:not(.set-mini):not(.set-chip) { min-height: 44px; touch-action: manipulation; }
}

@media (max-width: 640px) {
  .set.pane { padding: 12px 12px calc(18px + env(safe-area-inset-bottom)); gap: 12px; }
  .set-panel-intro { padding: 12px; }
  .set .card { padding: 12px !important; }
  .set .row2 { grid-template-columns: 1fr; }
  .set-row { flex-direction: column; gap: 8px; }
  .set-appearance { flex-direction: column; align-items: stretch; gap: 10px; }
  .set-appearance .theme-control-card { align-self: flex-start; }
  .set-switch { align-self: flex-start; }
  .set-field-action { flex-direction: column; align-items: stretch; }
  .set-field-action > .btn { align-self: flex-start; }
  .set-key-status .btn:first-of-type { margin-left: 0; }
  .set-runtime-row, .set-project-row { align-items: flex-start; flex-wrap: wrap; }
  .set-runtime-row .trunc, .set-project-row .trunc,
  .set-runtime-row .set-wrap, .set-project-row .set-wrap { flex-basis: 100%; }
  .set-filter-field, .set-filter-field > .field { min-width: 0; max-width: none; width: 100%; }
  .set-filter-actions { margin-left: 0; }
  .set-facts > div { grid-template-columns: 1fr; gap: 2px; }
}
`;


/* ── demo mode ────────────────────────────────────────────────────────────
   For screenshots. Masking happens in the main process at the IPC boundary,
   so this panel only turns it on and shows what it is doing — a mapping you
   cannot inspect is one you cannot trust before you publish a screenshot.
   ──────────────────────────────────────────────────────────────────────── */

function DemoPanel() {
  const [state, setState] = useState<{ on: boolean; map: { real: string; fake: string }[] }>({ on: false, map: [] });
  const [blur, setBlur] = useState(() => {
    try { return localStorage.getItem('wanigan.demo.blurTerminal') === '1'; } catch { return false; }
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => { window.wanigan.demo.state().then(setState).catch(() => {}); }, []);
  useEffect(() => {
    document.documentElement.toggleAttribute('data-demo-blur', blur && state.on);
    try { localStorage.setItem('wanigan.demo.blurTerminal', blur ? '1' : '0'); } catch { /* blocked */ }
  }, [blur, state.on]);

  async function toggle() {
    setBusy(true);
    try {
      await window.wanigan.demo.set(!state.on);
      // Reload rather than just flipping the flag. Views hold data fetched
      // before the toggle, so without this the rail keeps showing real project
      // names while this panel shows masked ones — half-masked is the one
      // outcome worse than not masking at all, because it looks done.
      window.location.reload();
    } catch { setBusy(false); }
  }

  return (
    <Section title="Demo mode"
             hint="Replaces your project names, paths, usernames and git authors with plausible fakes everywhere in the app, so a screenshot shows the tool rather than your work.">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className={state.on ? 'btn btn-primary' : 'btn'} disabled={busy} onClick={() => void toggle()}>
          {busy ? '…' : state.on ? 'Demo mode is on' : 'Turn on demo mode'}
        </button>
        <span className="faint" style={{ fontSize: 'var(--t-small)' }}>⌘⇧D toggles it without touching the mouse.</span>
      </div>

      {state.on && (
        <>
          <div style={{ marginTop: 10 }}>
            <label style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 'var(--t-small)' }}>
              <input type="checkbox" checked={blur} onChange={(e) => setBlur(e.target.checked)} style={{ marginTop: 3 }} />
              <span>
                <strong>Blur terminals too.</strong> A live terminal draws raw bytes from the agent, so nothing in the
                app can rewrite what it already printed. Masking cannot reach it — blurring can.
              </span>
            </label>
          </div>

          <div style={{ marginTop: 10 }}>
            <div className="label">What your projects look like right now</div>
            <table className="viz-table">
              <tbody>
                {state.map.slice(0, 12).map((m) => (
                  <tr key={m.real}>
                    <td className="mono" style={{ fontSize: 'var(--t-micro)', color: 'var(--text-faint)' }}>{m.fake}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="faint" style={{ fontSize: 'var(--t-small)', marginTop: 6, lineHeight: 1.5 }}>
              Only the masked side is listed — printing the real paths beside them would put the thing you are
              hiding on the screen you are about to photograph.
            </p>
          </div>
        </>
      )}
    </Section>
  );
}
