import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HeadlessConfig, HeadlessRow, HeadlessRun, Project, ProviderId, ProviderInfo } from '@shared/types';
import { Note, Stat, ago, num, usd } from '../components/bits';

const TIMEOUTS = [5, 15, 30, 60] as const;
const msg = (e: unknown) => e instanceof Error ? e.message : String(e);

/**
 * The attended face of a headless fan-out.  Starting it from a schedule is
 * useful, but review cannot be a background feature: every row ends here with
 * its worktree, output and exact terminal outcome.
 */
export default function HeadlessRuns({ projects, providers }: { projects: Project[]; providers: ProviderInfo[] }) {
  const [runs, setRuns] = useState<HeadlessRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<HeadlessRow[]>([]);
  const [providerId, setProviderId] = useState<ProviderId>('claude');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(projects.map((p) => p.id)));
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [providerOptions, setProviderOptions] = useState<Record<string, string | boolean>>({});
  const [budget, setBudget] = useState('2');
  const [minutes, setMinutes] = useState<number>(15);
  const [isolate, setIsolate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const installed = providers.filter((p) => p.path && p.capabilities.headlessJson);
  const provider = providers.find((p) => p.id === providerId);
  const modelField = provider?.launchFields?.find((field) => field.id === 'model');
  const effortField = provider?.launchFields?.find((field) => field.id === 'effort');
  const current = runs.find((r) => r.id === selected) ?? null;

  useEffect(() => {
    setModel(typeof modelField?.defaultValue === 'string' ? modelField.defaultValue : '');
    setEffort(typeof effortField?.defaultValue === 'string' ? effortField.defaultValue : '');
    const defaults: Record<string, string | boolean> = {};
    for (const field of provider?.launchFields ?? []) {
      if (['model', 'effort', 'permissionMode'].includes(field.id)) continue;
      if (field.defaultValue !== undefined) defaults[field.id] = field.defaultValue;
      else if (field.kind === 'boolean') defaults[field.id] = false;
    }
    setProviderOptions(defaults);
  }, [providerId, provider?.launchFields, modelField?.defaultValue, effortField?.defaultValue]);

  useEffect(() => {
    if (!installed.some((candidate) => candidate.id === providerId)) {
      setProviderId(installed[0]?.id ?? '');
    }
  }, [providers, providerId]);

  const load = useCallback(async () => {
    const next = await window.wanigan.headless.runs(50);
    setRuns(next);
    setSelected((old) => old && next.some((r) => r.id === old) ? old : (next[0]?.id ?? null));
  }, []);

  useEffect(() => { void load().catch((e) => setErr(msg(e))); const t = setInterval(() => void load().catch(() => {}), 3000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    let alive = true;
    if (!selected) { setRows([]); return; }
    void window.wanigan.headless.rows(selected).then((r) => { if (alive) setRows(r); }).catch((e) => alive && setErr(msg(e)));
    return () => { alive = false; };
  }, [selected, runs]);

  const allPicked = chosen.size === projects.length && projects.length > 0;
  const toggleProject = (id: string) => setChosen((prior) => {
    const next = new Set(prior); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const missingRequired = (provider?.launchFields ?? []).find((field) => {
    if (!field.required) return false;
    // Headless permission mode is derived from each project's trust level; it
    // is deliberately not a user-supplied launch option.
    if (field.id === 'permissionMode') return false;
    const value = field.id === 'model' ? model
      : field.id === 'effort' ? effort
        : providerOptions[field.id];
    return value === undefined || value === null || value === '';
  });
  const canStart = !!provider?.path && prompt.trim().length > 0 && chosen.size > 0
    && !missingRequired && !busy;

  async function start() {
    if (!canStart) return;
    setBusy(true); setErr(null);
    const cfg: HeadlessConfig = {
      name: name.trim() || `fan-out · ${new Date().toLocaleString()}`,
      providerId, projectIds: [...chosen], prompt: prompt.trim(), model: model.trim() || undefined,
      effort: effort.trim() || undefined, providerOptions,
      maxBudgetUsd: Math.max(0, Number(budget) || 0), timeoutMs: minutes * 60_000, isolate,
    };
    try {
      const result = await window.wanigan.headless.start(cfg);
      setPrompt(''); setName(''); setSelected(result.runId); await load();
    } catch (e) { setErr(msg(e)); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!current) return;
    try { await window.wanigan.headless.cancel(current.id); await load(); }
    catch (e) { setErr(msg(e)); }
  }

  async function merge(row: HeadlessRow) {
    if (!row.worktree) return;
    try {
      const r = await window.wanigan.worktrees.merge(row.worktree, { squash: true, message: `wanigan: ${current?.name ?? 'headless run'} · ${row.projectName}` });
      if (!r.merged) throw new Error(r.detail);
      await load();
    } catch (e) { setErr(msg(e)); }
  }

  const totals = useMemo(() => rows.reduce((a, r) => ({
    changed: a.changed + r.filesChanged, cost: a.cost + r.costUsd,
  }), { changed: 0, cost: 0 }), [rows]);

  return (
    <div style={{ padding: '22px 26px', overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h1 style={{ margin: 0 }}>Headless runs</h1>
        <span className="faint">one prompt × selected repositories</span>
      </div>
      <p className="dim" style={{ maxWidth: '78ch', lineHeight: 1.5 }}>
        This is unattended work with a per-repository timeout and CLI budget. Isolated worktrees are on by default;
        review and merge each finished row deliberately.
      </p>
      {err && <Note tone="error">{err}</Note>}

      <section className="sunk" style={{ marginTop: 14, padding: 14 }}>
        <div className="label">Start a fan-out</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 8 }}>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Run name (optional)" />
          <select className="field" value={providerId} onChange={(e) => setProviderId(e.target.value as ProviderId)}>
            {installed.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {provider?.supports.model && (modelField?.kind === 'select' ? (
            <select className="field" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="" disabled={modelField.required}>{modelField.required ? `Choose ${modelField.label}…` : 'Provider default'}</option>
              {(modelField.options ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          ) : <input className="field" value={model} onChange={(e) => setModel(e.target.value)} placeholder={modelField?.label ?? 'model'} />)}
          {provider?.supports.effort && (effortField?.kind === 'select' ? (
            <select className="field" value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="" disabled={effortField.required}>{effortField.required ? `Choose ${effortField.label}…` : 'Provider default effort'}</option>
              {(effortField.options ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          ) : <input className="field" value={effort} onChange={(e) => setEffort(e.target.value)} placeholder={effortField?.label ?? 'effort'} />)}
          <select className="field" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {TIMEOUTS.map((m) => <option key={m} value={m}>{m} min/repo</option>)}
          </select>
        </div>
        <textarea className="field" value={prompt} onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Audit this repository, make the requested change, run the relevant checks, and report what you verified."
                  style={{ width: '100%', minHeight: 78, marginTop: 8, resize: 'vertical' }} />
        {(provider?.launchFields ?? []).filter((field) => !['model', 'effort', 'permissionMode'].includes(field.id)).length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginTop: 8 }}>
            {(provider?.launchFields ?? []).filter((field) => !['model', 'effort', 'permissionMode'].includes(field.id)).map((field) => (
              <label key={field.id} className="sunk" style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: 8 }}>
                <span className="label">{field.label}{field.required ? ' · required' : ''}</span>
                {field.description && <span className="faint">{field.description}</span>}
                {field.kind === 'boolean' ? (
                  <span><input type="checkbox" checked={providerOptions[field.id] === true}
                               onChange={(e) => setProviderOptions((old) => ({ ...old, [field.id]: e.target.checked }))} />{' '}
                    {providerOptions[field.id] === true ? 'Enabled' : 'Disabled'}</span>
                ) : field.kind === 'select' ? (
                  <select className="field" value={String(providerOptions[field.id] ?? '')}
                          onChange={(e) => setProviderOptions((old) => ({ ...old, [field.id]: e.target.value }))}>
                    <option value="">{field.required ? 'Choose…' : 'Provider default'}</option>
                    {(field.options ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                  </select>
                ) : (
                  <input className="field mono" type={field.kind === 'secret' ? 'password' : 'text'}
                         value={String(providerOptions[field.id] ?? '')}
                         onChange={(e) => setProviderOptions((old) => ({ ...old, [field.id]: e.target.value }))} />
                )}
              </label>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <label className="faint">CLI budget/repo <input className="field" style={{ width: 68, marginLeft: 5 }} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
          <label className="faint"><input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} /> isolate in worktrees</label>
          <button className="btn" onClick={() => setChosen(allPicked ? new Set() : new Set(projects.map((p) => p.id)))}>{allPicked ? 'Clear projects' : 'All projects'}</button>
          <button className="btn btn-primary" disabled={!canStart} onClick={() => void start()}>{busy ? 'Starting…' : `Run in ${chosen.size} repo${chosen.size === 1 ? '' : 's'}`}</button>
        </div>
        {missingRequired && <Note tone="warn">{missingRequired.label} is required by this provider profile.</Note>}
        {!provider?.capabilities.policy && provider && <Note tone="warn">{provider.label} is allowed only when this project is Trusted: Wanigan cannot enforce its Claude-style unattended policy boundary yet.</Note>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {projects.map((p) => <button key={p.id} className="pill" aria-pressed={chosen.has(p.id)} onClick={() => toggleProject(p.id)}>{chosen.has(p.id) ? '✓ ' : ''}{p.name}</button>)}
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, .8fr) minmax(460px, 1.6fr)', gap: 14, marginTop: 14 }}>
        <section className="sunk" style={{ padding: 12 }}>
          <div className="label">Recent runs</div>
          {runs.length === 0 ? <p className="faint">Nothing has run yet.</p> : runs.map((r) => (
            <button key={r.id} className="btn" onClick={() => setSelected(r.id)} style={{ width: '100%', display: 'block', textAlign: 'left', marginTop: 7, borderColor: r.id === selected ? 'var(--accent)' : undefined }}>
              <strong>{r.name}</strong><br />
              <span className="faint">{r.succeeded} passed · {r.failed} failed · {r.blocked} blocked · {r.open} open · {usd(r.costUsd)} · {ago(r.createdAt)}</span>
            </button>
          ))}
        </section>
        <section className="sunk" style={{ padding: 12 }}>
          {!current ? <p className="faint">Select a run to inspect its repositories.</p> : <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
              <h2 style={{ margin: 0 }}>{current.name}</h2><span className="faint">{current.model} · {current.status}</span>
              {current.open > 0 && <button className="btn btn-danger" style={{ marginLeft: 'auto' }} onClick={() => void cancel()}>Cancel run</button>}
            </div>
            <div className="stat-grid" style={{ margin: '12px 0' }}>
              <Stat label="Succeeded" value={num(current.succeeded)} sub={`${num(current.failed)} failed · ${num(current.blocked)} blocked`} />
              <Stat label="Changed" value={num(totals.changed)} sub="files outside the launch baseline" />
              <Stat label="Cost" value={usd(totals.cost)} sub="CLI-reported; never estimated" />
            </div>
            {rows.map((row) => <article key={row.projectId} style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><strong>{row.projectName}</strong><span className="faint">{row.status} · {row.filesChanged} files · {usd(row.costUsd)}</span>
                {row.worktree && row.status === 'succeeded' && <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => void merge(row)}>Squash merge</button>}
              </div>
              {row.error && <p style={{ color: 'var(--bad)', whiteSpace: 'pre-wrap', margin: '5px 0' }}>{row.error}</p>}
              {row.output && <details><summary className="faint">agent output</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{row.output}</pre></details>}
            </article>)}
          </>}
        </section>
      </div>
    </div>
  );
}
