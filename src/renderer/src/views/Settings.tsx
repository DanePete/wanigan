import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  WaniganSettings, EgressHost, LedgerEntry, McpServerConfig, MotionSetting,
  MobileMonitorConfig, MobileMonitorStatus, Project, ProviderInfo, QueueItem, QueueSlots, QueueState,
  TrustLevel, UploadedFile, WorktreeInfo,
} from '@shared/types';
import { TRUST_COPY, TRUST_LEVELS } from '@shared/types';
import { Note, Section, Stat, ago, num } from '../components/bits';

type KeyStatus = { present: boolean; fingerprint: string | null; encryptionAvailable: boolean; fromEnv: boolean; workspaceId: string | null };
type ProviderKeyStatus = { present: boolean; fingerprint: string | null };

/* ── formatting ──────────────────────────────────────────────────────── */

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function bytes(n: number): string {
  if (n < 1024) return `${num(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
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

function Mark({ glyph, word, color, title }: MarkSpec & { title?: string }) {
  return (
    <span className="set-mark" style={{ color }} title={title}>
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
 * bits.tsx's <Note tone="warn"> reaches for --warn-soft, a token the sheet does
 * not define, so a warning would render on a transparent ground. The warnings
 * on this page are the load-bearing part, so they use the --warning /
 * --critical tokens that do exist. Info and ok still reuse <Note>.
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
  return (
    <div role="radiogroup" aria-label={label} className="set-opts">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button key={o.id} type="button" role="radio" aria-checked={on}
                  className={`set-opt${on ? ' on' : ''}`} onClick={() => onPick(o.id)}>
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

/* ════════════════════════════════════════════════════════════════════════
   The page
   ════════════════════════════════════════════════════════════════════════ */

export default function Settings({ providers, projects, onKeyChange, onRemoveProject, onAddProject }: {
  providers: ProviderInfo[];
  projects: Project[];
  onKeyChange: () => void;
  onRemoveProject: (id: string) => void;
  onAddProject: () => void;
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

  const load = () => window.wanigan.key.status().then((st) => {
    setStatus(st);
    if (st.workspaceId) { setWorkspaceId(st.workspaceId); setShowWorkspace(true); }
  });
  useEffect(() => {
    void load();
    void window.wanigan.key.provider('glm').then(setGlmStatus).catch(() => {});
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

  return (
    <div className="pane set" style={{ maxWidth: 780 }} data-motion={prefs?.motion ?? 'auto'}>
      <style>{SHEET}</style>

      <div className="pane-head"><div><h1>Settings</h1></div></div>

      <DemoPanel />

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 11 }}>
            <span className="pill" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>key installed</span>
            <span className="mono faint">{status.fingerprint}</span>
            {status.workspaceId && (
              <span className="pill mono" style={{ background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}
                    title="anthropic-workspace-id sent on every request">{status.workspaceId}</span>
            )}
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={verify} disabled={busy}>Verify</button>
            <button className="btn btn-danger" onClick={clear} disabled={busy}>Remove</button>
          </div>
        ) : (
          <div style={{ marginBottom: 11 }}>
            <Note tone="warn">
              No key stored. Batches cannot estimate or submit without one.
            </Note>
          </div>
        )}

        <label className="label">{status?.present ? 'Replace key' : 'Paste your key'}</label>
        <div style={{ display: 'flex', gap: 7, marginTop: 4 }}>
          <input className="field mono" type="password" placeholder="sk-ant-api03-…" value={input}
                 autoComplete="off" spellCheck={false}
                 onChange={(e) => setInput(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) void save(); }} />
          <button className="btn btn-primary" onClick={save} disabled={busy || !input.trim()}>
            {busy ? 'Verifying…' : 'Save'}
          </button>
        </div>

        {showWorkspace ? (
          <div style={{ marginTop: 11 }}>
            <label className="label">
              Workspace ID
              <span className="faint" style={{ textTransform: 'none' }}> — required for identity-linked keys</span>
            </label>
            <input className="field mono" style={{ marginTop: 4 }} placeholder="wrkspc_…"
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 11 }}>
            <span className="pill" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>Coding Plan key installed</span>
            <span className="mono faint">{glmStatus.fingerprint}</span>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => void verifyGlm()} disabled={glmBusy}>Verify live catalogue</button>
            <button className="btn btn-danger" onClick={() => void clearGlm()} disabled={glmBusy}>Remove</button>
          </div>
        ) : <Note tone="warn">No Z.ai Coding Plan key stored. GLM sessions cannot authenticate until you add one.</Note>}
        <label className="label" style={{ marginTop: 11 }}>{glmStatus?.present ? 'Replace Z.ai key' : 'Paste Z.ai Coding Plan API key'}</label>
        <div style={{ display: 'flex', gap: 7, marginTop: 4 }}>
          <input className="field mono" type="password" placeholder="Z.ai API key" value={glmKey} autoComplete="off" spellCheck={false}
                 onChange={(e) => setGlmKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && glmKey.trim()) void saveGlm(); }} />
          <button className="btn btn-primary" onClick={() => void saveGlm()} disabled={glmBusy || !glmKey.trim()}>{glmBusy ? 'Checking…' : 'Save & verify'}</button>
        </div>
        {glmMsg && <div style={{ marginTop: 10 }}><Note tone={glmMsg.tone === 'ok' ? 'ok' : 'error'}>{glmMsg.text}</Note></div>}
        <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 8, lineHeight: 1.45 }}>
          The key is verified against <span className="mono">api.z.ai/api/coding/paas/v4/models</span> before Wanigan saves it, then encrypted in your macOS Keychain. Wanigan does not show or log the key.
        </p>
      </Section>

      <Section title="Spending"
               hint="A batch cannot be un-submitted. The cap is checked against the estimate at submit time — the last moment anything is preventable.">
        <label className="label">Maximum estimated cost per run (USD)</label>
        <div style={{ display: 'flex', gap: 7, marginTop: 4, maxWidth: 320 }}>
          <input className="field mono" type="number" min={0} step="0.25" value={cap}
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
      </Section>

      {prefsErr && <Callout level="critical" title="A preference did not save.">{prefsErr}</Callout>}

      <Observation prefs={prefs} pending={pending} setFlag={setFlag} />
      <PhoneMonitor />
      <Egress />
      <Trust projects={projects} onAddProject={onAddProject} />
      <Dispatcher />
      <Mcp projects={projects} prefs={prefs} pending={pending} setFlag={setFlag} />
      <Worktrees />
      <Motion prefs={prefs} pending={pending} setPref={setPref} />
      <Storage prefs={prefs} pending={pending} setPref={setPref} />

      <Section title="Agents" hint="Resolved from your login shell's PATH, then from editor extension directories.">
        {providers.map((p) => (
          <div key={p.id} style={{ display: 'flex', gap: 11, alignItems: 'center', padding: '7px 0',
                                   borderTop: '1px solid var(--line-soft)' }}>
            <span style={{ fontWeight: 600, minWidth: 110 }}>{p.label}</span>
            {p.path ? (
              <>
                <span className="pill" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>{p.version ?? 'installed'}</span>
                <span className="faint mono trunc" style={{ fontSize: 'var(--t-micro)', flex: 1 }} title={p.path}>{p.path}</span>
              </>
            ) : (
              <span className="faint">not found — <code className="mono">{p.bin}</code> is not on PATH or in an editor extension</span>
            )}
          </div>
        ))}
      </Section>

      <Section title="Projects" hint="Shared by both views — an agent session and a batch run target the same repo."
               right={<button className="btn" onClick={onAddProject}>+ Add project</button>}>
        {!projects.length && <p className="dim">No projects yet.</p>}
        {projects.map((p) => (
          <div key={p.id} style={{ display: 'flex', gap: 11, alignItems: 'center', padding: '7px 0',
                                   borderTop: '1px solid var(--line-soft)' }}>
            <span style={{ fontWeight: 500 }}>{p.name}</span>
            {p.branch && <span className="pill mono" style={{ background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>{p.branch}</span>}
            <span className="faint mono trunc" style={{ fontSize: 'var(--t-micro)', flex: 1 }} title={p.path}>{p.path}</span>
            <button className="faint" style={{ fontSize: 'var(--t-small)' }} onClick={() => onRemoveProject(p.id)}>remove</button>
          </div>
        ))}
      </Section>
    </div>
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
      <Callout title="The phone surface cannot type into a terminal or approve a prompt.">
        It receives the Mac hostname, Wanigan version, an internal session id, project/session names,
        provider/model, state, session and update timestamps, spend, request/error counts, token counts
        and line totals.
        It does not receive repository paths, commands, hook details, terminal output, transcripts,
        worktrees, process ids or conversation ids. Remote controls need a separate threat model and are not hidden behind this switch.
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

function Trust({ projects, onAddProject }: { projects: Project[]; onAddProject: () => void }) {
  const [deniedOnly, setDeniedOnly] = useState(false);
  const [saved, setSaved] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  const trust = useLoad(async () => {
    const [dflt, perProject] = await Promise.all([
      window.wanigan.policy.defaultTrust(),
      Promise.all(projects.map(async (p) => ({ id: p.id, level: await window.wanigan.policy.trust(p.id) }))),
    ]);
    return { dflt, perProject: new Map(perProject.map((r) => [r.id, r.level])) };
  }, [projects.length]);

  const summary = useLoad(() => window.wanigan.policy.summary());
  const ledger = useLoad(() => window.wanigan.policy.ledger(200, deniedOnly), [deniedOnly]);

  const pick = async (fn: () => Promise<unknown>, text: string) => {
    setSaved(null);
    try { await fn(); trust.reload(); setSaved({ tone: 'ok', text }); }
    catch (e) { setSaved({ tone: 'error', text: msg(e) }); }
  };

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
                            <div className="faint set-path trunc" title={p.path}>{p.path}</div>
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

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0 8px', flexWrap: 'wrap' }}>
        <div className="set-chips" role="group" aria-label="Ledger filter">
          <button className={`set-chip${deniedOnly ? '' : ' on'}`} aria-pressed={!deniedOnly}
                  onClick={() => setDeniedOnly(false)}>Every decision</button>
          <button className={`set-chip${deniedOnly ? ' on' : ''}`} aria-pressed={deniedOnly}
                  onClick={() => setDeniedOnly(true)}>⊘ Denied only</button>
        </div>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={exportLedger} disabled={exporting}>
          {exporting ? 'Choosing a file…' : 'Export ledger (JSONL)'}
        </button>
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
          return (
            <>
              <div className="set-scroll wide">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>When</th><th>Project</th><th>Tool</th><th>What it asked for</th><th>Decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="set-when" title={fullDate(r.at)}>{ago(r.at)}</td>
                        <td className="trunc" style={{ maxWidth: 130 }} title={r.projectName ?? 'no project'}>
                          {r.projectName ?? <span className="faint">no project</span>}
                          <div className="faint" style={{ fontSize: 'var(--t-micro)' }}>{TRUST_COPY[r.trust]?.label ?? r.trust}</div>
                        </td>
                        <td className="mono" style={{ fontSize: 'var(--t-small)' }}>{r.toolName}</td>
                        <td className="trunc dim" style={{ maxWidth: 240 }} title={`${r.summary}\n\n${r.reason}`}>
                          {r.summary}
                          <div className="faint" style={{ fontSize: 'var(--t-micro)' }}>rule: {r.rule}</div>
                        </td>
                        <td><Mark {...DECISION[r.decision]} title={r.reason} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, lineHeight: 1.5 }}>
                Showing the {plural(rows.length, 'most recent row', 'most recent rows')}
                {deniedOnly ? ' that were denied' : ''}. Export writes the whole ledger, one JSON object
                per line, including the reason each rule gave.
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
   3 · Dispatcher
   ════════════════════════════════════════════════════════════════════════ */

const KIND_COPY: { id: keyof QueueSlots; label: string; detail: string }[] = [
  { id: 'session',  label: 'Interactive sessions', detail: 'Terminals you drive yourself.' },
  { id: 'headless', label: 'Headless runs',        detail: 'One unattended agent per repo.' },
  { id: 'batch',    label: 'Batch submissions',    detail: 'Submissions in flight against the Batches API.' },
];

function Dispatcher() {
  const [draft, setDraft] = useState<QueueSlots | null>(null);
  const [saved, setSaved] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [tick, setTick] = useState(0);

  const slots = useLoad(() => window.wanigan.queue.slots());
  const queue = useLoad(() => window.wanigan.queue.list(60), [tick]);

  // The queue moves on its own, so the table follows it rather than waiting for
  // the user to come back and reopen the page.
  useEffect(() => {
    const off = window.wanigan.on.queueChanged(() => setTick((t) => t + 1));
    const timer = setInterval(() => setTick((t) => t + 1), 5000);
    return () => { off(); clearInterval(timer); };
  }, []);

  const running = useMemo(() => {
    const by: Record<string, number> = { session: 0, headless: 0, batch: 0 };
    if (queue.v.s === 'ok') for (const q of queue.v.d) if (q.state === 'running') by[q.kind] = (by[q.kind] ?? 0) + 1;
    return by;
  }, [queue.v]);

  async function saveSlots(next: QueueSlots) {
    setSaved(null);
    try {
      const applied = await window.wanigan.queue.setSlots(next);
      setDraft(applied);
      slots.reload();
      setSaved({ tone: 'ok', text: `Wanigan will now start at most ${applied.session} sessions, ${applied.headless} headless runs and ${applied.batch} batch submissions at a time.` });
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
             hint="How much Wanigan starts at once, and what is holding. Work above the limit waits in the queue instead of all launching together and starving the machine.">
      <Frame v={slots.v} what="the slot limits" onRetry={slots.reload}>
        {(loaded) => {
          const d = draft ?? loaded;
          const dirty = (['session', 'headless', 'batch'] as const).some((k) => d[k] !== loaded[k]);
          return (
          <>
            {KIND_COPY.map(({ id, label, detail }) => {
              const inUse = running[id] ?? 0;
              const limit = Math.max(1, d[id]);
              return (
                <div className="set-row" key={id}>
                  <div className="txt">
                    <h4>{label}</h4>
                    <p>{detail}</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 6, maxWidth: 300 }}>
                      <div className="set-meter" style={{ flex: 1 }}>
                        <span style={{ width: `${Math.min(100, (inUse / limit) * 100)}%` }} />
                      </div>
                      <span className="faint" style={{ fontSize: 'var(--t-micro)', fontVariantNumeric: 'tabular-nums' }}>
                        {inUse} of {limit} running
                      </span>
                    </div>
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
              <span className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.45 }}>
                1 to 64 per surface. Lowering a number never stops work already running — it only
                narrows what the next tick starts.
              </span>
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
                        <td className="trunc" style={{ maxWidth: 210 }} title={q.label}>{q.label}</td>
                        <td className="dim">{q.kind}</td>
                        <td><Mark {...s} /></td>
                        <td className="dim trunc" style={{ maxWidth: 200 }}
                            title={q.error ?? q.blockedBy ?? undefined}>
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

const BLANK: Draft = { name: '', projectId: '', transport: 'stdio', command: '', args: '', url: '', enabled: true };

function Mcp({ projects, prefs, pending, setFlag }: {
  projects: Project[]; prefs: WaniganSettings | null; pending: string | null;
  setFlag: (k: string, on: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [tick, setTick] = useState(0);

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
      setSaved({ tone: 'ok', text: `“${s.name}” is ${on ? 'enabled' : 'disabled'} for new sessions.` });
    } catch (e) { setSaved({ tone: 'error', text: msg(e) }); }
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
      <Callout level="warning" title="Turning this on lets a session dispatch batch work that costs real money.">
        An agent connected to this server can build and queue a batch run against your Claude Platform
        key. <strong>Submission always stops for a human.</strong> Wanigan raises a system dialog
        naming the run and its estimated cost, and nothing reaches the API until you press Submit —
        a model asking is never enough, and a batch cannot be un-submitted. The server binds to
        loopback with a bearer token minted at launch, so only a process on this machine that Wanigan
        handed the token to can reach it.
      </Callout>

      {prefs && (
        <div style={{ marginTop: 4 }}>
          <Toggle title="Enable Wanigan's MCP server" on={prefs.mcpServerEnabled} busy={pending === 'mcp_server'}
                  onChange={(v) => void setFlag('mcp_server', v)}>
            Off by default. The port is bound once, when Wanigan starts, so switching this on takes
            effect at the next launch. After that, point a session at the URL below and it can read
            your runs and prepare a submission for you to approve.
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
            <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--t-small)' }}>
              <input type="checkbox" checked={draft.enabled}
                     onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
              Give it to new sessions
            </label>
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
                  {list.map((s) => (
                    <tr key={s.id}>
                      <td className="mono" style={{ fontSize: 'var(--t-small)' }}>{s.name}</td>
                      <td className="dim">{s.projectId === null ? 'global' : projectName(s.projectId)}</td>
                      <td className="set-path trunc" style={{ maxWidth: 210 }}
                          title={s.transport === 'stdio' ? `${s.command ?? ''} ${s.args ?? ''}`.trim() : s.url}>
                        {s.transport === 'stdio' ? `${s.command ?? ''} ${s.args ?? ''}`.trim() : s.url}
                      </td>
                      <td>
                        <button className="set-mini" aria-pressed={s.enabled}
                                onClick={() => void toggleServer(s, !s.enabled)}>
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
                  ))}
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
                            <div className="set-path" title={w.path}>{fileName(w.path)}</div>
                            <div className="faint" style={{ fontSize: 'var(--t-micro)' }}>in {w.repoRoot}</div>
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
   6 · Motion
   ════════════════════════════════════════════════════════════════════════ */

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
                            <td className="mono trunc" style={{ fontSize: 'var(--t-small)', maxWidth: 220 }} title={t.sessionId}>
                              {t.sessionId}
                            </td>
                            <td className="set-n">{num(t.turns)}</td>
                            <td className="set-n">{bytes(t.bytes)}</td>
                            <td className="set-when" title={fullDate(t.archivedAt)}>{ago(t.archivedAt)}</td>
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
                            <td className="set-path trunc" style={{ maxWidth: 240 }} title={u.path}>{fileName(u.path)}</td>
                            <td className="dim mono" style={{ fontSize: 'var(--t-micro)' }}>{u.mediaType}</td>
                            <td className="set-n">{bytes(u.bytes)}</td>
                            <td className="set-when" title={fullDate(u.uploadedAt)}>{ago(u.uploadedAt)}</td>
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
   Styles

   Settings owns no feature stylesheet: index.css belongs to the shell and each
   styles/*.css belongs to the phase that made it. So the rules this surface
   needs, and only this surface needs, live here, scoped to .set. Not one colour
   is declared — every value is a token from index.css.
   ════════════════════════════════════════════════════════════════════════ */

const SHEET = `
.set :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 5px; }

/* The motion setting is real on the surface that sets it. */
.set[data-motion='off'] * { transition: none !important; animation: none !important; }
@media (prefers-reduced-motion: reduce) {
  .set[data-motion='auto'] * { transition: none !important; animation: none !important; }
}

/* Wide tables scroll inside themselves. The page body never scrolls sideways. */
.set-scroll { overflow-x: auto; overflow-y: hidden; }
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

.set-empty { padding: 20px 14px; text-align: center;
             font-size: 12.5px; line-height: 1.55; color: var(--text-dim); }

.set-mini { padding: 2px 7px; border-radius: 6px; font-size: 11px; font-weight: 600; color: var(--text-dim); }
.set-mini:hover { background: var(--bg-sunk); color: var(--text); }
.set-mini.danger:hover { background: var(--critical-soft); color: var(--critical); }
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
