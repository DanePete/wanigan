import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  HeadlessConfig, HeadlessRowSummary, HeadlessRun, Project, ProviderId, ProviderInfo,
} from '@shared/types';
import { ConfirmNote, EmptyState, Note, Reading, Stat, ago, num, usd } from '../components/bits';
import '../styles/runs.css';

const TIMEOUTS = [5, 15, 30, 60] as const;
const msg = (e: unknown) => e instanceof Error ? e.message : String(e);
const sameIds = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((id) => b.has(id));

/** One row's stdout and error, once somebody has asked to see them. */
type RowDetailState = { loading: boolean; output: string | null; error: string | null; failed: string | null };

/**
 * What actually changed about the selected run.
 *
 * The three-second poll replaces the `runs` array wholesale, so an effect that
 * depends on the array refires every beat whether or not the run it is watching
 * moved. Depending on the counters instead means the rows are re-read when a
 * repository finishes and at no other time.
 */
const runSignature = (run: HeadlessRun | null): string => (run
  ? `${run.id}:${run.status}:${run.succeeded}:${run.failed}:${run.blocked}:${run.open}:${run.filesChanged}`
  : '');

/**
 * One row's cost, or the honest absence of one. A row whose agent named no
 * figure is stored as 0 and must not be printed as "$0.00" beside rows that
 * were actually priced — that is the same zero the run total used to sum
 * under the words "never estimated".
 */
function rowCost(row: HeadlessRowSummary): string {
  if (row.status !== 'succeeded' && row.status !== 'timeout') return usd(row.costUsd);
  return row.costReported === true ? usd(row.costUsd) : 'no cost reported';
}

/**
 * The attended face of a headless fan-out.  Starting it from a schedule is
 * useful, but review cannot be a background feature: every row ends here with
 * its worktree, output and exact terminal outcome.
 */
export default function HeadlessRuns({ projects, providers }: { projects: Project[]; providers: ProviderInfo[] }) {
  const [runs, setRuns] = useState<HeadlessRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<HeadlessRowSummary[]>([]);
  // Output and errors are fetched per row, on expand, and kept keyed by
  // project id so collapsing and reopening a row does not re-cross IPC.
  const [details, setDetails] = useState<Record<string, RowDetailState>>({});
  const [providerId, setProviderId] = useState<ProviderId>('claude');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(projects.map((p) => p.id)));
  // The project list resolves asynchronously, so this view can mount before it
  // arrives. Until the operator picks for themselves, the selection is still
  // Wanigan's default — every repository — and has to follow the list rather
  // than freeze an empty default nothing explains. Once they have picked, their
  // choice is the record: a project that disappeared drops out and nothing is
  // ever silently re-selected.
  const picked = useRef(false);
  /** Rows whose detail has been requested for the run currently selected. */
  const asked = useRef<Set<string>>(new Set());
  /** So a detail response that outlives its run can be discarded. */
  const selectedRef = useRef<string | null>(null);
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
  /**
   * Whether the run list has ever come back, and why the last attempt did not.
   *
   * `runs` starts empty, so this screen spent its first frames — and the whole
   * of a broken IPC read — reporting a history of zero, "Nothing has run yet",
   * and "No run selected". That empty array reads the same whether the history
   * really is empty or was never fetched, and only one of those is a fact.
   * `loaded` is set by a read that returned, never by one that threw.
   */
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);

  const installed = providers.filter((p) => p.path && p.capabilities.headlessJson);
  const provider = providers.find((p) => p.id === providerId);
  const modelField = provider?.launchFields?.find((field) => field.id === 'model');
  const effortField = provider?.launchFields?.find((field) => field.id === 'effort');
  const current = runs.find((r) => r.id === selected) ?? null;
  selectedRef.current = selected;

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

  useEffect(() => {
    const live = new Set(projects.map((p) => p.id));
    setChosen((prior) => {
      const next = picked.current
        ? new Set([...prior].filter((id) => live.has(id)))
        : live;
      return sameIds(prior, next) ? prior : next;
    });
  }, [projects]);

  const load = useCallback(async () => {
    const next = await window.wanigan.headless.runs(50);
    setRuns(next);
    setSelected((old) => old && next.some((r) => r.id === old) ? old : (next[0]?.id ?? null));
    setLoaded(true);
    setLoadFailed(null);
  }, []);

  // Every beat records its own failure rather than the first one alone. Before
  // a read has ever landed the failure is the only thing this screen can
  // honestly show, and the three-second beat is also the automatic retry
  // standing behind the button in the history panel.
  const reload = useCallback(() => void load().catch((e) => setLoadFailed(msg(e))), [load]);

  useEffect(() => { reload(); const t = setInterval(reload, 3000); return () => clearInterval(t); }, [reload]);

  const signature = runSignature(current);
  useEffect(() => {
    let alive = true;
    if (!selected) { setRows([]); return; }
    void window.wanigan.headless.rows(selected).then((r) => { if (alive) setRows(r); }).catch((e) => alive && setErr(msg(e)));
    return () => { alive = false; };
    // Keyed to what the selected run reports about itself, not to the array the
    // poll replaces every three seconds. `runs` is deliberately absent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, signature]);

  // Detail belongs to the run it was fetched for; switching runs must not leave
  // one repository's output hanging under another run's row of the same name.
  useEffect(() => { asked.current = new Set(); setDetails({}); }, [selected]);

  /**
   * Fetch one row's stdout and error, on expand.
   *
   * The list channel carries status only — twenty repositories at 50 KB of
   * output apiece is 20 MB a minute across IPC to paint a table that shows none
   * of it — so the text stays in SQLite until somebody opens the row. Asked-for
   * ids are remembered, so collapsing and reopening a row costs nothing; a
   * failed read forgets itself, so it can be tried again.
   */
  const loadDetail = useCallback(async (projectId: string) => {
    const runId = selected;
    if (!runId || asked.current.has(projectId)) return;
    asked.current.add(projectId);
    setDetails((prior) => ({ ...prior, [projectId]: { loading: true, output: null, error: null, failed: null } }));
    try {
      const d = await window.wanigan.headless.rowDetail(runId, projectId);
      if (selectedRef.current !== runId) return;   // the operator moved on mid-flight
      setDetails((prior) => ({ ...prior, [projectId]: { loading: false, output: d.output, error: d.error, failed: null } }));
    } catch (e) {
      asked.current.delete(projectId);
      if (selectedRef.current !== runId) return;
      setDetails((prior) => ({ ...prior, [projectId]: { loading: false, output: null, error: null, failed: msg(e) } }));
    }
  }, [selected]);

  const allPicked = chosen.size === projects.length && projects.length > 0;
  const toggleProject = (id: string) => {
    picked.current = true;
    setChosen((prior) => {
      const next = new Set(prior); next.has(id) ? next.delete(id) : next.add(id); return next;
    });
  };
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

  // Merging a worktree into the project branch rewrites the branch and cannot
  // be undone by looking again, so it names the branch and the file count and
  // waits for a second, deliberate press. (CLAUDE.md: destructive git work is
  // never one click.)
  const [confirmMerge, setConfirmMerge] = useState<string | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  async function merge(row: HeadlessRowSummary) {
    if (!row.worktree) return;
    setMerging(row.projectId);
    try {
      const r = await window.wanigan.worktrees.merge(row.worktree, { squash: true, message: `wanigan: ${current?.name ?? 'headless run'} · ${row.projectName}` });
      if (!r.merged) throw new Error(r.detail);
      setConfirmMerge(null);
      await load();
    } catch (e) { setErr(msg(e)); }
    finally { setMerging(null); }
  }

  const totals = useMemo(() => rows.reduce((a, r) => ({
    changed: a.changed + r.filesChanged, cost: a.cost + r.costUsd,
  }), { changed: 0, cost: 0 }), [rows]);

  /**
   * How complete the cost total is, in the same three words the Usage screen
   * already uses for the identical situation. Only rows where the agent
   * actually ran can report anything, so a blocked or cancelled row is not a
   * gap. `costReported === null` is a row written before the column existed:
   * unknown, counted as not reported rather than assumed good.
   */
  const costStatus = useMemo(() => {
    const ran = rows.filter((r) => r.status === 'succeeded' || r.status === 'timeout');
    if (ran.length === 0) return { kind: 'reported' as const, missing: 0 };
    const missing = ran.filter((r) => r.costReported !== true).length;
    return {
      kind: missing === 0 ? 'reported' as const
        : missing === ran.length ? 'unreported' as const : 'partial' as const,
      missing,
    };
  }, [rows]);

  return (
    <main className="pane hr-view">
      <header className="hr-head">
        <div className="hr-head-copy">
          <span className="label-stencil">Headless runs · unattended workflows</span>
          <h1>Runs</h1>
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
          <button className="btn" onClick={() => { picked.current = true; setChosen(allPicked ? new Set() : new Set(projects.map((p) => p.id))); }}>{allPicked ? 'Clear projects' : 'Select all projects'}</button>
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
          {/* The count is a claim about the database, so it waits for the read
              too: a bare 0 beside "Recent runs" is indistinguishable from a
              history nobody has fetched. */}
          <div className="hr-section-head"><div><span className="label">History</span><h2 id="headless-history-title">Recent runs</h2></div><span className="hr-count">{loaded ? runs.length : '—'}</span></div>
          {!loaded ? (
            loadFailed === null
              ? <Reading what="recent runs" />
              : <EmptyState posture="could-not-read" title="Could not read recent runs"
                            cue={loadFailed}
                            action={<button className="btn" onClick={reload}>Try again</button>} />
          ) : runs.length === 0 ? (
            <EmptyState posture="nothing-yet" title="Nothing has run yet"
                        cue="A completed fan-out stays here for review, with its cost and every repository's outcome." />
          ) : runs.map((r) => (
            <button key={r.id} className={`hr-run${r.id === selected ? ' on' : ''}`} onClick={() => setSelected(r.id)} aria-pressed={r.id === selected}>
              <strong>{r.name}</strong>
              <span>{r.succeeded} passed · {r.failed} failed · {r.blocked} blocked · {r.open} open</span>
              <small>{r.costStatus === 'unreported' ? 'no cost reported'
                : r.costStatus === 'partial' ? `≥ ${usd(r.costUsd)}` : usd(r.costUsd)} · {ago(r.createdAt)}</small>
            </button>
          ))}
        </section>
        <section className="card hr-detail">
          {/* Nothing to inspect until a run exists: an inspector panel with no
              subject is a card that can only say it is empty. Which of its two
              empty sentences is the true one depends on the history read, so it
              waits for that read instead of inviting a fan-out over a list that
              may be full. */}
          {!loaded ? (
            loadFailed === null
              ? <Reading what="the run history" />
              : <EmptyState posture="could-not-read" title="No run to inspect"
                            cue="The run history could not be read, so there is nothing here to select. Recent runs carries the error and a retry." />
          ) : !current ? (
            runs.length === 0
              ? <EmptyState posture="nothing-yet" title="No run selected"
                            cue="Start a fan-out above; its repositories, outputs and costs appear here." />
              : <EmptyState posture="nothing-in-scope" title="No run selected"
                            cue="Choose a run on the left to inspect the repositories it touched." />
          ) : <>
            {/* Only the outcome line is announced. The panel below it is
                replaced by a three-second poll, and a live region around all of
                it would re-read every repository, its output and its cost on
                every beat. */}
            <div className="hr-detail-title"><div><span className="label">Run review</span><h2>{current.name}</h2><p className="faint" aria-live="polite" aria-atomic="true">{current.model} · {current.status} · {current.open} open</p></div>
              {current.open > 0 && <button className="btn btn-danger" onClick={() => void cancel()}>Cancel run</button>}
            </div>
            <div className="stat-grid hr-stats">
              <Stat label="Succeeded" value={num(current.succeeded)} sub={`${num(current.failed)} failed · ${num(current.blocked)} blocked`} />
              <Stat label="Changed" value={num(totals.changed)} sub="files outside the launch baseline" />
              {/* The strongest truth claim on this screen used to sit on its
                  least complete number: a repository whose agent reported no
                  cost is stored as $0.00, so "never estimated" was true of the
                  arithmetic and false about the total. Same three readings the
                  Usage screen gives, and the confident wording is kept only
                  for the case that earns it. */}
              <Stat label="Cost"
                    value={costStatus.kind === 'unreported' ? '—' : costStatus.kind === 'partial' ? `≥ ${usd(totals.cost)}` : usd(totals.cost)}
                    sub={costStatus.kind === 'unreported'
                      ? 'no repository reported a cost, so there is no figure to show'
                      : costStatus.kind === 'partial'
                        ? `a floor · ${num(costStatus.missing)} ${costStatus.missing === 1 ? 'repository' : 'repositories'} reported no cost`
                        : 'CLI-reported; never estimated'} />
            </div>
            <div className="hr-rows">{rows.map((row) => {
              const d = details[row.projectId];
              const expandable = row.hasError || row.hasOutput;
              return (
                <article key={row.projectId} className="hr-row">
                  <div className="hr-row-head"><div><strong>{row.projectName}</strong><span className="faint">{row.status} · {row.filesChanged} files · {rowCost(row)}</span></div>
                    {row.worktree && row.status === 'succeeded' && (
                      <button className="btn" aria-expanded={confirmMerge === row.projectId}
                              onClick={() => setConfirmMerge(confirmMerge === row.projectId ? null : row.projectId)}>
                        Squash merge…
                      </button>
                    )}
                  </div>
                  {confirmMerge === row.projectId && (
                    <ConfirmNote
                      what={<>Squash-merge {row.filesChanged === 1 ? 'the 1 changed file' : `the ${num(row.filesChanged)} changed files`} from
                        this run's worktree into <strong>{row.projectName}</strong>'s branch? The worktree's history is squashed into one
                        commit on the branch; this cannot be undone from here.</>}
                      verb="Squash merge" busy={merging === row.projectId}
                      onRun={() => merge(row)} onCancel={() => setConfirmMerge(null)} />
                  )}
                  {/* The list channel deliberately carries no text at all, so
                      even a one-line error is behind this expander. The summary
                      says which of the two is waiting there, so a failed row is
                      still findable without opening every row on the run. */}
                  {expandable && (
                    <details className="hr-output"
                             onToggle={(e) => { if (e.currentTarget.open) void loadDetail(row.projectId); }}>
                      <summary>
                        {row.hasError && row.hasOutput ? 'Error and agent output'
                          : row.hasError ? 'Why this repository failed' : 'Agent output'}
                      </summary>
                      {d?.loading && <p className="faint">Reading this row…</p>}
                      {d?.failed && (
                        <p className="hr-row-error">
                          Could not read this row: {d.failed}. The run and its output are untouched —
                          only this read failed.
                        </p>
                      )}
                      {d && !d.loading && !d.failed && (
                        <>
                          {d.error && <p className="hr-row-error">{d.error}</p>}
                          {d.output
                            ? <pre>{d.output}</pre>
                            : !d.error && <p className="faint">This row recorded no output.</p>}
                        </>
                      )}
                    </details>
                  )}
                </article>
              );
            })}</div>
          </>}
        </section>
      </div>
    </main>
  );
}
