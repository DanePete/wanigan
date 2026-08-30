import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HeadlessConfig, HeadlessRow, HeadlessRun, Project, ProviderId, ProviderInfo } from '@shared/types';
import { Note, Stat, ago, num, usd } from '../components/bits';
import '../styles/runs.css';

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
    <main className="pane hr-view">
      <header className="hr-head">
        <div className="hr-head-copy">
          <span className="label">Unattended workflows</span>
          <h1>Headless runs</h1>
          <p className="dim">
            One prompt × selected repositories. Each repository gets its own timeout and CLI budget;
            isolated worktrees stay on by default so review and merge remain deliberate.
          </p>
        </div>
        <span className="hr-head-status">{projects.length} project{projects.length === 1 ? '' : 's'} available</span>
      </header>
      {err && <Note tone="error">{err}</Note>}

      <section className="card hr-launch" aria-labelledby="headless-launch-title">
        <div className="hr-section-head">
          <div><span className="label">Configure</span><h2 id="headless-launch-title">Start a fan-out</h2><p className="dim">Choose the agent and guardrails first, then pick the repositories that receive the same task.</p></div>
          <span className="hr-step">1 of 2</span>
        </div>
        <div className="hr-form-grid">
          <label className="hr-field"><span className="label">Run name <em>optional</em></span><input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly repository audit" /></label>
          <label className="hr-field"><span className="label">Provider</span><select className="field" value={providerId} onChange={(e) => setProviderId(e.target.value as ProviderId)}>
            {installed.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select></label>
          {provider?.supports.model && <label className="hr-field"><span className="label">{modelField?.label ?? 'Model'}{modelField?.required ? ' · required' : ''}</span>{modelField?.kind === 'select' ? (
            <select className="field" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="" disabled={modelField.required}>{modelField.required ? `Choose ${modelField.label}…` : 'Provider default'}</option>
              {(modelField.options ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          ) : <input className="field" value={model} onChange={(e) => setModel(e.target.value)} placeholder={modelField?.label ?? 'Model'} />}</label>}
          {provider?.supports.effort && <label className="hr-field"><span className="label">{effortField?.label ?? 'Reasoning effort'}{effortField?.required ? ' · required' : ''}</span>{effortField?.kind === 'select' ? (
            <select className="field" value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="" disabled={effortField.required}>{effortField.required ? `Choose ${effortField.label}…` : 'Provider default effort'}</option>
              {(effortField.options ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          ) : <input className="field" value={effort} onChange={(e) => setEffort(e.target.value)} placeholder={effortField?.label ?? 'Reasoning effort'} />}</label>}
          <label className="hr-field"><span className="label">Timeout per repository</span><select className="field" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {TIMEOUTS.map((m) => <option key={m} value={m}>{m} minutes</option>)}
          </select></label>
        </div>
        <label className="hr-field hr-prompt"><span className="label">Task for every repository</span><textarea className="field" value={prompt} onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Audit this repository, make the requested change, run the relevant checks, and report what you verified." />
          <span className="faint">Use one self-contained request. Wanigan launches an isolated worker for each selected repository.</span></label>
        {(provider?.launchFields ?? []).filter((field) => !['model', 'effort', 'permissionMode'].includes(field.id)).length > 0 && (
          <div className="hr-provider-fields" aria-label="Provider-specific options">
            {(provider?.launchFields ?? []).filter((field) => !['model', 'effort', 'permissionMode'].includes(field.id)).map((field) => (
              <label key={field.id} className="hr-provider-field sunk">
                <span className="label">{field.label}{field.required ? ' · required' : ''}</span>
                {field.description && <span className="faint">{field.description}</span>}
                {field.kind === 'boolean' ? (
                  <span className="hr-check"><input type="checkbox" checked={providerOptions[field.id] === true}
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
        <div className="hr-launch-footer">
          <label className="hr-budget"><span className="label">CLI budget / repository</span><div><span aria-hidden="true">$</span><input className="field" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} /></div></label>
          <label className="hr-check"><input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} /> isolate in worktrees</label>
          <button className="btn" onClick={() => setChosen(allPicked ? new Set() : new Set(projects.map((p) => p.id)))}>{allPicked ? 'Clear projects' : 'Select all projects'}</button>
        </div>
        {missingRequired && <Note tone="warn">{missingRequired.label} is required by this provider profile.</Note>}
        {!provider?.capabilities.policy && provider && <Note tone="warn">{provider.label} is allowed only when this project is Trusted: Wanigan cannot enforce its Claude-style unattended policy boundary yet.</Note>}
        <div className="hr-project-picker" role="group" aria-label="Select repositories for this run">
          <div className="hr-project-picker-head"><div><span className="label">Repositories</span><p className="dim">{chosen.size} selected · each receives the same task independently.</p></div><span className="hr-step">2 of 2</span></div>
          <div className="hr-projects">
            {projects.map((p) => <button key={p.id} className={`hr-project${chosen.has(p.id) ? ' on' : ''}`} aria-pressed={chosen.has(p.id)} onClick={() => toggleProject(p.id)}><span aria-hidden="true" className="hr-project-mark">{chosen.has(p.id) ? '✓' : '+'}</span>{p.name}</button>)}
          </div>
          <div className="hr-submit-row"><span className="faint">{canStart ? 'Ready to start the selected agents.' : 'Add a task, select at least one repository, and complete provider requirements.'}</span><button className="btn btn-primary" disabled={!canStart} onClick={() => void start()}>{busy ? 'Starting…' : `Run in ${chosen.size} repo${chosen.size === 1 ? '' : 's'}`}</button></div>
        </div>
      </section>

      <div className="hr-workspace">
        <section className="card hr-history" aria-labelledby="headless-history-title">
          <div className="hr-section-head"><div><span className="label">History</span><h2 id="headless-history-title">Recent runs</h2></div><span className="hr-count">{runs.length}</span></div>
          {runs.length === 0 ? <p className="faint hr-empty">Nothing has run yet. Your completed fan-outs will remain here for review.</p> : runs.map((r) => (
            <button key={r.id} className={`hr-run${r.id === selected ? ' on' : ''}`} onClick={() => setSelected(r.id)} aria-pressed={r.id === selected}>
              <strong>{r.name}</strong>
              <span>{r.succeeded} passed · {r.failed} failed · {r.blocked} blocked · {r.open} open</span>
              <small>{usd(r.costUsd)} · {ago(r.createdAt)}</small>
            </button>
          ))}
        </section>
        <section className="card hr-detail" aria-live="polite">
          {!current ? <p className="faint hr-empty">Select a run to inspect the repositories it touched.</p> : <>
            <div className="hr-detail-title"><div><span className="label">Run review</span><h2>{current.name}</h2><p className="faint">{current.model} · {current.status}</p></div>
              {current.open > 0 && <button className="btn btn-danger" onClick={() => void cancel()}>Cancel run</button>}
            </div>
            <div className="stat-grid hr-stats">
              <Stat label="Succeeded" value={num(current.succeeded)} sub={`${num(current.failed)} failed · ${num(current.blocked)} blocked`} />
              <Stat label="Changed" value={num(totals.changed)} sub="files outside the launch baseline" />
              <Stat label="Cost" value={usd(totals.cost)} sub="CLI-reported; never estimated" />
            </div>
            <div className="hr-rows">{rows.map((row) => <article key={row.projectId} className="hr-row">
              <div className="hr-row-head"><div><strong>{row.projectName}</strong><span className="faint">{row.status} · {row.filesChanged} files · {usd(row.costUsd)}</span></div>
                {row.worktree && row.status === 'succeeded' && <button className="btn" onClick={() => void merge(row)}>Squash merge</button>}
              </div>
              {row.error && <p className="hr-row-error">{row.error}</p>}
              {row.output && <details className="hr-output"><summary>Agent output</summary><pre>{row.output}</pre></details>}
            </article>)}</div>
          </>}
        </section>
      </div>
    </main>
  );
}
