import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@shared/types';
import { Note, Stat, ago, num } from '../components/bits';

type Kind = 'headless' | 'session' | 'batch';
type Schedule = {
  id: string; name: string; cron: string; kind: Kind; payload: unknown;
  projectId: string | null; enabled: boolean; createdAt: number;
  nextAt: number | null; lastAt: number | null; lastStatus: string | null;
  lastDetail: string | null; runs: number; describe: string;
};

/* Presets people actually want, phrased as the job rather than the syntax.
   Deliberately off :00 and :30 — Claude Code's own scheduler adds jitter there,
   and a job pinned to the top of the hour is a job competing with every other. */
const PRESETS: { label: string; cron: string }[] = [
  { label: 'every 15 min', cron: '*/15 * * * *' },
  { label: 'hourly', cron: '7 * * * *' },
  { label: 'nightly 03:00', cron: '3 3 * * *' },
  { label: 'weekday mornings', cron: '7 9 * * 1-5' },
  { label: 'Monday 08:00', cron: '7 8 * * 1' },
];

const when = (t: number | null) => (t === null ? '—' : new Date(t).toLocaleString(undefined, {
  weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric',
}));

export default function Schedules({ projects }: { projects: Project[] }) {
  const [list, setList] = useState<Schedule[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [cron, setCron] = useState('3 3 * * *');
  const [kind, setKind] = useState<Kind>('headless');
  const [projectId, setProjectId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState<{ fires: number[]; describe: string } | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [hist, setHist] = useState<Record<string, { at: number; status: string; detail: string | null }[]>>({});

  const load = useCallback(async () => {
    try { setList(await window.wanigan.schedule.list()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);

  // Show the next five fires before anything is saved. A cron expression you
  // cannot read is a schedule you cannot audit.
  useEffect(() => {
    let live = true;
    window.wanigan.schedule.preview(cron)
      .then((p) => { if (live) { setPreview(p); setPreviewErr(null); } })
      .catch((e) => { if (live) { setPreview(null); setPreviewErr(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [cron]);

  async function create() {
    setBusy(true);
    try {
      await window.wanigan.schedule.create({
        name: name.trim() || `${kind} · ${cron}`,
        cron: cron.trim(), kind,
        payload: kind === 'headless' ? { prompt: prompt.trim() } : { prompt: prompt.trim() },
        projectId: projectId || null,
      });
      setName(''); setPrompt('');
      await load();
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function toggle(s: Schedule) {
    try { await window.wanigan.schedule.setEnabled(s.id, !s.enabled); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  async function remove(s: Schedule) {
    try { await window.wanigan.schedule.remove(s.id); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  async function history(s: Schedule) {
    if (hist[s.id]) { setHist((h) => { const n = { ...h }; delete n[s.id]; return n; }); return; }
    try {
      const rows = await window.wanigan.schedule.history(s.id, 8);
      setHist((h) => ({ ...h, [s.id]: rows }));
    } catch { /* a schedule with no history is the normal case */ }
  }

  const live = list.filter((s) => s.enabled);
  const nextUp = live.filter((s) => s.nextAt).sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0))[0];

  return (
    <div className="sc-wrap">
      <div className="sc-head">
        <h1>Schedules</h1>
        <span className="n">{live.length} running · {list.length - live.length} paused</span>
      </div>

      <p className="dim" style={{ maxWidth: '74ch', marginTop: 6, lineHeight: 1.55 }}>
        These survive a quit and never expire. Claude Code's own <span className="mono">/loop</span> only fires
        while a session is open and deletes itself after seven days — that is the right call for a terminal,
        and the wrong one for a machine you leave running.
      </p>

      {err && <div style={{ marginTop: 10 }}><Note tone="error">{err}</Note></div>}

      <div className="stat-grid" style={{ marginTop: 12 }}>
        <Stat label="Running" value={num(live.length)} sub="armed and counting down" />
        <Stat label="Next fire" value={nextUp ? when(nextUp.nextAt) : '—'} sub={nextUp?.name ?? 'nothing scheduled'} />
        <Stat label="Total runs" value={num(list.reduce((a, s) => a + s.runs, 0))} sub="since you created them" />
        <Stat label="Last failure" value={list.some((s) => s.lastStatus === 'failed') ? 'yes' : 'none'}
              tone={list.some((s) => s.lastStatus === 'failed') ? 'var(--bad)' : undefined}
              sub={list.find((s) => s.lastStatus === 'failed')?.name ?? 'all clear'} />
      </div>

      <div className="sc-new">
        <div className="label" style={{ margin: 0 }}>New schedule</div>
        <div className="sc-row">
          <div className="sc-f" style={{ flex: 2, minWidth: 200 }}>
            <span className="label">Name</span>
            <input className="field" value={name} placeholder="Nightly audit"
                   onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="sc-f" style={{ flex: 1, minWidth: 150 }}>
            <span className="label">Cron</span>
            <input className="field mono" value={cron} onChange={(e) => setCron(e.target.value)} />
          </div>
          <div className="sc-f" style={{ minWidth: 130 }}>
            <span className="label">What runs</span>
            <select className="field" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="headless">Headless run</option>
              <option value="batch">Batch run</option>
              <option value="session">Session</option>
            </select>
          </div>
          <div className="sc-f" style={{ minWidth: 150 }}>
            <span className="label">Project</span>
            <select className="field" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Every project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>

        <div className="sc-presets">
          {PRESETS.map((p) => (
            <button key={p.cron} className="sc-preset" type="button" onClick={() => setCron(p.cron)}>{p.label}</button>
          ))}
        </div>

        <div className="sc-f">
          <span className="label">Prompt</span>
          <input className="field" value={prompt} placeholder="Audit every controller for N+1 queries"
                 onChange={(e) => setPrompt(e.target.value)} />
        </div>

        {previewErr ? (
          <Note tone="error">{previewErr}</Note>
        ) : preview && preview.fires.length > 0 ? (
          <div className="sc-preview">
            <strong>{preview.describe}</strong> — next:{' '}
            {preview.fires.slice(0, 3).map((f, i) => (
              <span key={f}><span className="when">{when(f)}</span>{i < 2 ? ', ' : ''}</span>
            ))}
          </div>
        ) : (
          <div className="sc-preview">That expression never matches a real date.</div>
        )}

        <div>
          <button className="btn btn-primary" disabled={busy || !preview?.fires.length} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create schedule'}
          </button>
        </div>
      </div>

      {list.length === 0 ? (
        <p className="faint" style={{ marginTop: 18, maxWidth: '60ch', lineHeight: 1.55 }}>
          Nothing scheduled. A nightly headless run across every project is the one most people want first —
          it is the thing Wanigan can do that a session-scoped loop cannot.
        </p>
      ) : (
        <div className="sc-list">
          {list.map((s) => {
            const failed = s.lastStatus === 'failed';
            return (
              <div key={s.id} className={`sc-item${s.enabled ? '' : ' off'}`}>
                <div className="sc-item-top">
                  <span className="nm">{s.name}</span>
                  <span className="cron">{s.cron}</span>
                  <span className="kind">{s.kind}</span>
                  <span className="dim" style={{ fontSize: 'var(--t-small)' }}>{s.describe}</span>
                </div>
                <div className="sc-meta">
                  <span className={s.enabled ? 'due' : ''}>
                    {s.enabled
                      ? <><span aria-hidden="true">▸ </span>next {when(s.nextAt)}</>
                      : <><span aria-hidden="true">‖ </span>paused</>}
                  </span>
                  <span>{num(s.runs)} run{s.runs === 1 ? '' : 's'}</span>
                  {s.lastAt && <span>last {ago(s.lastAt)}</span>}
                  {failed && <span className="bad"><span aria-hidden="true">✕ </span>{s.lastDetail ?? 'failed'}</span>}
                  {s.projectId && <span>{projects.find((p) => p.id === s.projectId)?.name ?? s.projectId}</span>}
                </div>
                <div className="sc-actions">
                  <button className="btn" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }} onClick={() => void toggle(s)}>
                    {s.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button className="btn" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }} onClick={() => void history(s)}>
                    {hist[s.id] ? 'Hide history' : 'History'}
                  </button>
                  <button className="btn btn-danger" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                          onClick={() => void remove(s)}>Delete</button>
                </div>
                {hist[s.id] && (
                  <div className="sc-hist">
                    {hist[s.id].length === 0
                      ? <div>Never fired yet.</div>
                      : hist[s.id].map((h, i) => (
                        <div key={i}>
                          <span style={{ width: 130 }}>{when(h.at)}</span>
                          <span style={{ color: h.status === 'failed' ? 'var(--bad)' : 'var(--good)' }}>
                            {h.status === 'failed' ? '✕' : '✓'} {h.status}
                          </span>
                          {h.detail && <span>{h.detail}</span>}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
