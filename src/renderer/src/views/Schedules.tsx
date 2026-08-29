import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@shared/types';
import { Note, Stat, ago, num, usd } from '../components/bits';

/* What a schedule can be created as.
   'session' is deliberately absent. An unattended PTY that nobody is watching
   is more concurrency, not more review capacity, and the queue has never had a
   runner registered for that kind — every session schedule ever created sat in
   the queue blocked on "no runner registered" and fired nothing. Rows written
   by an older build are still in the database, so the stored shape below still
   admits the value rather than pretending those rows are not there. */
type Kind = 'headless' | 'batch';

type Schedule = {
  id: string; name: string; cron: string; kind: Kind | 'session'; payload: unknown;
  projectId: string | null; enabled: boolean; createdAt: number;
  nextAt: number | null; lastAt: number | null; lastStatus: string | null;
  lastDetail: string | null; runs: number; describe: string;
};

/* The columns the re-run picker reads. batch.runs() hands back the whole row,
   config_json included; a schedule stores the run id and nothing more, so the
   system prompt and the dataset stay in the runs table where they were. */
type RunOption = {
  id: string; name: string; kind: string; model: string; status: string;
  total_requests: number; est_cost_usd: number; cost_usd: number; created_at: number;
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

/**
 * What a batch schedule points at, read defensively.
 *
 * Batch schedules created before this form could describe one carry a bare
 * `{ prompt }` — a batch is a whole RunConfig, so those can never submit
 * anything. Returning null for them is what lets the list say so instead of
 * showing a healthy-looking row that fails at 03:00.
 */
function batchTarget(p: unknown): { runId: string; runName: string | null } | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as { runId?: unknown; runName?: unknown };
  if (typeof o.runId !== 'string' || !o.runId) return null;
  return { runId: o.runId, runName: typeof o.runName === 'string' ? o.runName : null };
}

export default function Schedules({ projects }: { projects: Project[] }) {
  const [list, setList] = useState<Schedule[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [cron, setCron] = useState('3 3 * * *');
  const [kind, setKind] = useState<Kind>('headless');
  const [projectId, setProjectId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [rerunId, setRerunId] = useState('');
  const [runs, setRuns] = useState<RunOption[]>([]);
  const [runsErr, setRunsErr] = useState<string | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ fires: number[]; describe: string } | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [hist, setHist] = useState<Record<string, { at: number; status: string; detail: string | null }[]>>({});
  const [daemon, setDaemon] = useState<{ supported: boolean; installed: boolean; detail: string } | null>(null);

  const load = useCallback(async () => {
    try { setList(await window.wanigan.schedule.list()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { void window.wanigan.schedule.daemon().then(setDaemon).catch(() => {}); }, []);

  async function toggleDaemon(on: boolean) {
    try {
      const next = on ? await window.wanigan.schedule.installDaemon() : await window.wanigan.schedule.uninstallDaemon();
      setDaemon(next); setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  // Show the next five fires before anything is saved. A cron expression you
  // cannot read is a schedule you cannot audit.
  useEffect(() => {
    let live = true;
    window.wanigan.schedule.preview(cron)
      .then((p) => { if (live) { setPreview(p); setPreviewErr(null); } })
      .catch((e) => { if (live) { setPreview(null); setPreviewErr(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [cron]);

  // Only fetched once a batch is actually being described. Both of these are
  // database reads the headless path has no use for, and the run list carries
  // every run's config with it.
  useEffect(() => {
    if (kind !== 'batch') return;
    let live = true;
    void (async () => {
      try {
        const rows = (await window.wanigan.batch.runs()) as RunOption[];
        // Headless fan-outs live in the same runs table. A HeadlessConfig is not
        // a RunConfig, so offering one here would build a schedule that submits
        // nonsense at 03:00 rather than one that fails now.
        if (live) { setRuns(rows.filter((r) => r.kind === 'batch')); setRunsErr(null); }
      } catch (e) { if (live) setRunsErr(e instanceof Error ? e.message : String(e)); }
      try {
        const s = await window.wanigan.settings.get();
        if (live) setCap(s.spendCapUsd);
      } catch { /* the cap shown here is a warning; submit.ts holds the real one */ }
    })();
    return () => { live = false; };
  }, [kind]);

  const chosen = runs.find((r) => r.id === rerunId) ?? null;
  // Only claimed when the run's settled cost is already over the cap: the cap is
  // checked against the ceiling of a fresh estimate, so a run that has actually
  // billed more than the cap cannot come in under it by accident. The reverse
  // inference would be a false green.
  const overCap = chosen !== null && cap !== null && cap > 0 && chosen.cost_usd > cap;

  async function create() {
    setBusy(true);
    try {
      const target = kind === 'batch' ? runs.find((r) => r.id === rerunId) : undefined;
      if (kind === 'batch' && !target) {
        throw new Error('Pick the run this schedule re-submits. A batch is a dataset, a model and a template — a prompt box cannot carry one.');
      }
      await window.wanigan.schedule.create({
        name: name.trim() || (target ? `re-run · ${target.name}` : `${kind} · ${cron}`),
        cron: cron.trim(), kind,
        // A batch is a whole RunConfig, so the payload names the run to
        // re-submit and the runner reads that run's config when it fires.
        // Copying the config in here instead would freeze the dataset at the
        // moment the schedule was written and put a second copy of the prompt
        // somewhere nobody would think to look for it.
        payload: target ? { runId: target.id, runName: target.name } : { prompt: prompt.trim() },
        projectId: projectId || null,
      });
      setName(''); setPrompt(''); setRerunId('');
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
        A schedule is a row in your database, not a timer inside a session: it survives a quit and never expires.
        Firing still needs this app running — the ticker lives in Wanigan's own process, so anything that came due
        while it was closed fires once when you next open it, not once for every tick that was missed. Claude
        Code's <span className="mono">/loop</span> lasts only as long as its session and deletes itself after
        seven days; that is the right call for a terminal and the wrong one for a machine you leave running.
      </p>

      {daemon && (
        <div className="sunk" style={{ marginTop: 10, padding: '9px 11px', display: 'flex', gap: 10, alignItems: 'center', maxWidth: '74ch' }}>
          <span className="faint">{daemon.detail}</span>
          {daemon.supported && <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => void toggleDaemon(!daemon.installed)}>
            {daemon.installed ? 'Stop background scheduler' : 'Run schedules while Wanigan is closed'}
          </button>}
        </div>
      )}

      {err && <div style={{ marginTop: 10 }}><Note tone="error">{err}</Note></div>}

      <div className="stat-grid" style={{ marginTop: 12 }}>
        <Stat label="Running" value={num(live.length)} sub="counting down while Wanigan is open" />
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
              <option value="batch">Batch re-run</option>
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

        {kind === 'headless' ? (
          <div className="sc-f">
            <span className="label">Prompt</span>
            <input className="field" value={prompt} placeholder="Audit every controller for N+1 queries"
                   onChange={(e) => setPrompt(e.target.value)} />
          </div>
        ) : (
          <div className="sc-f">
            <span className="label">Run to re-submit</span>
            <select className="field" value={rerunId} onChange={(e) => setRerunId(e.target.value)}>
              <option value="">Pick a run…</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {num(r.total_requests)} requests · {r.model}
                </option>
              ))}
            </select>

            {runsErr ? (
              <Note tone="error">{runsErr}</Note>
            ) : runs.length === 0 ? (
              <div className="sc-preview">
                No batch runs to re-submit yet. Build one in Batches and read its results first — a schedule is for
                work you have already checked once, which is the only kind worth firing at 03:00 with nobody watching.
              </div>
            ) : (
              <div className="sc-preview">
                {chosen ? (
                  <>
                    Every fire reads <strong>{chosen.name}</strong>'s own config and submits it again as a new run.
                    {' '}
                    {chosen.cost_usd > 0
                      ? `It cost ${usd(chosen.cost_usd)} the last time it ran.`
                      : `It has no settled cost yet — it was estimated at ${usd(chosen.est_cost_usd)}.`}
                    {' '}
                    A glob, files or command source re-reads your disk at fire time, so the rows will be whatever is
                    there then; a pasted CSV or JSONL carries its own bytes and sends exactly the same rows again.
                  </>
                ) : (
                  'The schedule stores the run id rather than a copy of its config, so editing the run changes what fires.'
                )}
              </div>
            )}

            {overCap && chosen && (
              <Note tone="warn">
                {chosen.name} billed {usd(chosen.cost_usd)}, which is over your {usd(cap ?? 0)} per-run spend cap.
                Unless it prices lower at fire time the submission is refused and nothing is spent — raise the cap in
                Settings, or schedule a smaller run.
              </Note>
            )}
          </div>
        )}

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
          {/* An empty prompt and an unpicked run both make a schedule that can
              only fail on its first fire, hours after the person who wrote it
              has stopped looking at this screen. */}
          <button className="btn btn-primary"
                  disabled={busy || !preview?.fires.length || (kind === 'batch' ? !chosen : !prompt.trim())}
                  onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create schedule'}
          </button>
        </div>
      </div>

      {list.length === 0 ? (
        <p className="faint" style={{ marginTop: 18, maxWidth: '64ch', lineHeight: 1.55 }}>
          Nothing scheduled. Two are worth having first: a nightly headless run across every project, and a batch
          you have already read the results of, re-submitted overnight at half the synchronous price.
        </p>
      ) : (
        <div className="sc-list">
          {list.map((s) => {
            const failed = s.lastStatus === 'failed';
            const target = s.kind === 'batch' ? batchTarget(s.payload) : null;
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
                  {target && <span>re-submits {target.runName ?? target.runId}</span>}
                  {failed && <span className="bad"><span aria-hidden="true">✕ </span>{s.lastDetail ?? 'failed'}</span>}
                  {s.projectId && <span>{projects.find((p) => p.id === s.projectId)?.name ?? s.projectId}</span>}
                </div>

                {/* Two shapes of dead schedule that otherwise sit here looking
                    armed: a session, which no runner has ever picked up, and a
                    batch written before this form could name a run, whose
                    payload is a bare prompt no batch can be built from. */}
                {s.kind === 'session' && (
                  <Note tone="warn">
                    Session schedules were removed — an unattended terminal nobody is watching is more concurrency,
                    not more review. This one has never started anything. Delete it, or recreate it as a headless run.
                  </Note>
                )}
                {s.kind === 'batch' && !target && (
                  <Note tone="warn">
                    This one names no run to re-submit, so every fire fails. It was created when the form could only
                    store a prompt, and a batch needs a dataset, a model and a template. Delete it and create it again.
                  </Note>
                )}
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
