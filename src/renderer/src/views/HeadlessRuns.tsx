import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  HeadlessRowSummary, HeadlessRun, HeadlessStartRequest, Project, ProviderId, ProviderInfo,
} from '@shared/types';
import { ConfirmNote, EmptyState, Note, Reading, Stat, ago, num, usd } from '../components/bits';
import '../styles/runs.css';

const TIMEOUTS = [5, 15, 30, 60] as const;
const msg = (e: unknown) => e instanceof Error ? e.message : String(e);
const sameIds = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((id) => b.has(id));

/** One row's stdout and error, once somebody has asked to see them. */
type RowDetailState = { loading: boolean; output: string | null; error: string | null; failed: string | null };

/**
 * The repository rows on screen, and the run they were read for.
 *
 * They used to be a bare array that was emptied only when the selection
 * emptied. Selecting run B after `headless:rows` rejected for it therefore left
 * run A's repositories, file counts and cost sitting under run B's name — and
 * the Squash merge button beside them acted on run A's worktree while stamping
 * run B's name into the squash commit, permanently, in git history. Carrying
 * the run id the array was fetched for is what makes that unrepresentable:
 * nothing below renders unless `runId` is the run that is selected.
 *
 * `rows` is null until a read for this run returned — the difference between
 * "this run has no repositories" and "nobody has answered yet". `error` is why
 * the last read did not return.
 */
type RowsState = { runId: string; rows: HeadlessRowSummary[] | null; error: string | null };

/**
 * What actually changed about the selected run.
 *
 * The three-second poll replaces the whole `runs` array whenever anything on
 * the history would paint differently — another run's counters, or a relative
 * timestamp rolling over — so an effect keyed to the array refires for reasons
 * that have nothing to do with the run it is watching. Depending on the
 * counters instead means a beat that changed nothing about this run does not
 * re-read its rows.
 */
const runSignature = (run: HeadlessRun | null): string => (run
  ? `${run.id}:${run.status}:${run.succeeded}:${run.failed}:${run.blocked}:${run.open}:${run.filesChanged}`
  : '');

/**
 * Everything the history list prints, as one string.
 *
 * `headless:runs` builds fresh objects on every call, so the poll handed
 * `setRuns` a new array twenty times a minute whether or not a run had moved,
 * and every one of those replacements re-rendered the list. The relative
 * timestamp is part of this on purpose: it is the one thing on a finished run
 * that keeps changing, so comparing against what was last accepted lets a quiet
 * beat keep its array without freezing "4m ago" on screen.
 */
const runsFingerprint = (list: HeadlessRun[]): string => list
  .map((r) => `${runSignature(r)}|${r.name}|${r.model}|${r.costUsd}|${r.costStatus}|${ago(r.createdAt)}`)
  .join('\n');

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
  const [rowsState, setRowsState] = useState<RowsState | null>(null);
  /** Bumped by the rows region's own retry, so a failed read can be asked again. */
  const [rowsNonce, setRowsNonce] = useState(0);
  // Output and errors are fetched per row, on expand, and kept keyed by
  // project id so collapsing and reopening a row does not re-cross IPC.
  const [details, setDetails] = useState<Record<string, RowDetailState>>({});
  const [providerId, setProviderId] = useState<ProviderId>('claude');
  // Empty on purpose. Seeding every registered project made the widest and most
  // expensive run the resting state of a form nobody had touched — the same
  // "nobody chose this" shape the fan-out guard in headless.ts exists to refuse
  // — and with two or more projects registered that default was rejected on
  // submit every time, by a message naming an intent this view could not state.
  // The operator names the repositories; "Select all projects" is still one
  // click away, and now it is a choice rather than a starting position.
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  /**
   * The operator saying "every registered repository" out loud.
   *
   * Never seeded true, and retired by any change to the selection or to the
   * registered list: it is a statement about one specific set of repositories
   * and cannot outlive that set. main refuses a start covering the whole
   * project list without it, because a payload that simply left the repository
   * out arrives there as exactly the same array.
   */
  const [declared, setDeclared] = useState(false);
  /**
   * The registered list as an identity.
   *
   * App rebuilds the `projects` array whenever a branch moves under one of them
   * (App.tsx:127 folds `branch` into the shape it compares), so keying anything
   * to the array itself would retire the declaration under the operator's
   * cursor every time they checked out elsewhere. Ids only.
   */
  const projectKey = projects.map((p) => p.id).join('|');
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
  // The single gate every row, stat and merge button below passes through.
  const rowsFor = rowsState && rowsState.runId === selected ? rowsState : null;
  const readRows = rowsFor?.rows ?? null;

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

  // Keyed to the ids, not to the array: a branch moving is not a list changing,
  // and unticking the declaration on that would pull it out from under someone
  // mid-form. A project that genuinely leaves drops out of the selection, and a
  // project joining or leaving retires the declaration — it was a statement
  // about the list as it stood, and this is no longer that list.
  useEffect(() => {
    const live = new Set(projectKey ? projectKey.split('|') : []);
    setChosen((prior) => {
      const next = new Set([...prior].filter((id) => live.has(id)));
      return sameIds(prior, next) ? prior : next;
    });
    setDeclared(false);
  }, [projectKey]);

  /** The fingerprint of the list this screen last accepted for painting. */
  const painted = useRef('');

  const load = useCallback(async () => {
    const next = await window.wanigan.headless.runs(50);
    // A beat that would paint the same list keeps the array it already has.
    // The comparison is against the fingerprint of the array in state, not
    // against `prior` inside an updater: the updater runs after this function
    // returns, so a ref written here would already equal the value it is
    // supposed to be compared with and every beat would be discarded.
    const look = runsFingerprint(next);
    if (look !== painted.current) { painted.current = look; setRuns(next); }
    setSelected((old) => old && next.some((r) => r.id === old) ? old : (next[0]?.id ?? null));
    setLoaded(true);
    setLoadFailed(null);
  }, []);

  // Every beat records its own failure rather than the first one alone. Before
  // a read has ever landed the failure is the only thing this screen can
  // honestly show, and the three-second beat, while the window is visible, is
  // also the automatic retry standing behind the button in the history panel.
  const reload = useCallback(() => void load().catch((e) => setLoadFailed(msg(e))), [load]);

  useEffect(() => {
    reload();
    // A hidden window is a window nobody is reading, and this beat is not free:
    // `headless:runs` is seven correlated subqueries per run over
    // `headless_rows`, whose only index is its (run_id, project_id) primary
    // key, and better-sqlite3 answers all of it synchronously on the main
    // process's single JavaScript thread. Fleet, Pet and the attention strip
    // already stop when the window is hidden; so does this. Coming back
    // re-reads at once rather than waiting out the rest of the interval.
    const t = setInterval(() => { if (document.hidden) return; reload(); }, 3000);
    const onVisible = () => { if (!document.hidden) reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [reload]);

  const signature = runSignature(current);
  useEffect(() => {
    let alive = true;
    if (!selected) { setRowsState(null); return; }
    const runId = selected;
    // The previous run's rows go here, at the top, on the selection change —
    // not when the new read returns and not only when the selection empties.
    // This is not about a late response arriving out of order; the `alive`
    // cleanup below has always handled that. It is about what the panel shows
    // in the meantime, and about what it keeps showing forever if this read
    // fails: rows belonging to a run whose name is no longer on the heading.
    setRowsState((prior) => {
      if (!prior || prior.runId !== runId) return { runId, rows: null, error: null };
      // Same run, re-read because one of its repositories finished or because
      // the rows region's Try again asked again. Its rows stay on screen, and a
      // previous failure is dropped: with nothing read yet that leaves "Reading
      // this run's repositories…", and with rows from an earlier read still on
      // screen it drops the warn Note over them until this read answers.
      return prior.error === null ? prior : { ...prior, error: null };
    });
    void window.wanigan.headless.rows(runId)
      .then((r) => { if (alive) setRowsState({ runId, rows: r, error: null }); })
      .catch((e) => {
        if (!alive) return;
        setRowsState((prior) => (prior && prior.runId === runId ? { ...prior, error: msg(e) } : prior));
      });
    return () => { alive = false; };
    // Keyed to what the selected run reports about itself, not to the array the
    // poll replaces every three seconds. `runs` is deliberately absent;
    // `rowsNonce` is the rows region's own Try again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, signature, rowsNonce]);

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
  /* The one selection main cannot tell apart from an accident: every repository
     Wanigan has registered. Below two there is nothing to declare — the guard
     in headless.ts does not fire on a single repository — so the control
     appears exactly when it means something, and naming three of eight still
     needs nothing. */
  const coversEveryProject = allPicked && projects.length > 1;
  const needsIntent = coversEveryProject && !declared;
  const toggleProject = (id: string) => {
    // Any change to the selection retires the declaration. Otherwise dropping a
    // repository and putting it back would re-declare a fan-out nobody re-read,
    // out of a tick made about a different list.
    setDeclared(false);
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
  /** What the budget field will actually send, so the copy below cannot quote a different figure. */
  const perRepoBudget = Math.max(0, Number(budget) || 0);
  const canStart = !!provider?.path && prompt.trim().length > 0 && chosen.size > 0
    && !missingRequired && !needsIntent && !busy;

  async function start() {
    if (!canStart) return;
    setBusy(true); setErr(null);
    const cfg: HeadlessStartRequest = {
      name: name.trim() || `fan-out · ${new Date().toLocaleString()}`,
      providerId, projectIds: [...chosen], prompt: prompt.trim(), model: model.trim() || undefined,
      effort: effort.trim() || undefined, providerOptions,
      maxBudgetUsd: perRepoBudget, timeoutMs: minutes * 60_000, isolate,
      // Written only when the selection really is the whole registered list, so
      // a run over three of eight repositories never carries — and never stores
      // in its config_json — a claim about a fan-out it did not do.
      ...(coversEveryProject && declared ? { allProjects: true } : {}),
    };
    try {
      const result = await window.wanigan.headless.start(cfg);
      // The declaration was spent on this run. The next one is asked again.
      setPrompt(''); setName(''); setDeclared(false); setSelected(result.runId); await load();
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
  // An armed confirmation belongs to the run it was armed on. It is held by
  // project id, and two runs over the same repository share that id, so
  // switching runs used to re-arm it on the other run's row of the same
  // project — measured: open the confirmation on run A's row, click run B, and
  // B's row for that repository is already expanded with its Squash merge
  // button under the cursor. The second deliberate press is the whole
  // protection here, so it is asked again per run.
  useEffect(() => { setConfirmMerge(null); }, [selected]);
  async function merge(row: HeadlessRowSummary) {
    if (!row.worktree) return;
    // The name in a squash commit is written into the project's branch and
    // cannot be corrected by looking again, so it comes from the row's own
    // `runId` rather than from whichever run happens to be selected. The
    // fallback is that id, which still names one run exactly; the `'headless
    // run'` it replaces named none.
    const runName = runs.find((r) => r.id === row.runId)?.name ?? row.runId;
    setMerging(row.projectId);
    try {
      const r = await window.wanigan.worktrees.merge(row.worktree, { squash: true, message: `wanigan: ${runName} · ${row.projectName}` });
      if (!r.merged) throw new Error(r.detail);
      setConfirmMerge(null);
      await load();
    } catch (e) { setErr(msg(e)); }
    finally { setMerging(null); }
  }

  // Both figures below are sums over the rows, so both are null until the rows
  // for the selected run are in hand. An unread run summing to zero prints as a
  // confident 0 files and $0.00, which is a claim about a read that has not
  // happened.
  const totals = useMemo(() => (readRows === null ? null : readRows.reduce((a, r) => ({
    changed: a.changed + r.filesChanged, cost: a.cost + r.costUsd,
  }), { changed: 0, cost: 0 })), [readRows]);

  /**
   * How complete the cost total is, in the same three words the Usage screen
   * already uses for the identical situation. Only rows where the agent
   * actually ran can report anything, so a blocked or cancelled row is not a
   * gap. `costReported === null` is a row written before the column existed:
   * unknown, counted as not reported rather than assumed good.
   */
  const costStatus = useMemo(() => {
    if (readRows === null) return null;
    const ran = readRows.filter((r) => r.status === 'succeeded' || r.status === 'timeout');
    if (ran.length === 0) return { kind: 'reported' as const, missing: 0 };
    const missing = ran.filter((r) => r.costReported !== true).length;
    return {
      kind: missing === 0 ? 'reported' as const
        : missing === ran.length ? 'unreported' as const : 'partial' as const,
      missing,
    };
  }, [readRows]);

  /** Why Changed and Cost have no figure. Both are sums over rows not in hand. */
  const rowsUnread = rowsFor?.error
    ? "this run's repositories could not be read"
    : "reading this run's repositories";

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
          {/* Selecting every repository is a selection, not a declaration: this
              button deliberately does not tick the box below, and clears a tick
              that was already there. */}
          <button className="btn" onClick={() => { setDeclared(false); setChosen(allPicked ? new Set() : new Set(projects.map((p) => p.id))); }}>{allPicked ? 'Clear projects' : 'Select all projects'}</button>
        </div>
        {missingRequired && <Note tone="warn">{missingRequired.label} is required by this provider profile.</Note>}
        {!provider?.capabilities.policy && provider && <Note tone="warn">{provider.label} is allowed only when this project is Trusted: Wanigan cannot enforce its Claude-style unattended policy boundary yet.</Note>}
        <div className="hr-project-picker" role="group" aria-label="Select repositories for this run">
          <div className="hr-project-picker-head"><div><span className="label">Repositories</span><p className="dim">{chosen.size} selected · each receives the same task independently.</p></div><span className="hr-step">2 of 2</span></div>
          <div className="hr-projects">
            {projects.map((p) => <button key={p.id} className={`hr-project${chosen.has(p.id) ? ' on' : ''}`} aria-pressed={chosen.has(p.id)} onClick={() => toggleProject(p.id)}><span aria-hidden="true" className="hr-project-mark">{chosen.has(p.id) ? '✓' : '+'}</span>{p.name}</button>)}
          </div>
          {/* The declaration sits with the repositories it is about: their names
              are the chips directly above, so this counts them rather than
              listing them again. The figure is the budget field's own value,
              which is what Wanigan passes to the CLI's budget flag — and at 0
              it passes no flag at all (headless.ts:306), which the copy says
              rather than printing a $0.00 ceiling that does not exist. */}
          {coversEveryProject && (
            <label className="hr-declare">
              <input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />
              <span>
                <strong>Run in every registered repository.</strong>{' '}
                {declared ? (perRepoBudget > 0
                  ? <>All {projects.length} start one unattended agent each, carrying the {usd(perRepoBudget)} per-repository budget Wanigan hands the CLI — up to {usd(perRepoBudget * projects.length)} across the fan-out if every one spends it. The CLI enforces that flag; Wanigan does not.</>
                  : <>All {projects.length} start one unattended agent each, and the budget is 0, so Wanigan passes no budget flag at all — nothing here caps what they spend.</>
                ) : (perRepoBudget > 0
                  ? <>Selecting every repository is the one request that reaches the runner looking exactly like a payload that named none, so it is said here rather than inferred. Right now that is all {projects.length} of them, at {usd(perRepoBudget)} each.</>
                  : <>Selecting every repository is the one request that reaches the runner looking exactly like a payload that named none, so it is said here rather than inferred. Right now that is all {projects.length} of them, with no budget flag passed.</>)}
              </span>
            </label>
          )}
          <div className="hr-submit-row"><span className="faint">{canStart ? 'Ready to start the selected agents.' : needsIntent ? 'This selection is every repository Wanigan has registered. Tick the declaration above, or drop one repository from the run.' : 'Add a task, select at least one repository, and complete provider requirements.'}</span><button className="btn btn-primary" disabled={!canStart} onClick={() => void start()}>{busy ? 'Starting…' : `Run in ${chosen.size} repo${chosen.size === 1 ? '' : 's'}`}</button></div>
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
              <Stat label="Changed" value={totals ? num(totals.changed) : '—'}
                    sub={totals ? 'files outside the launch baseline' : rowsUnread} />
              {/* The strongest truth claim on this screen used to sit on its
                  least complete number: a repository whose agent reported no
                  cost is stored as $0.00, so "never estimated" was true of the
                  arithmetic and false about the total. Same three readings the
                  Usage screen gives, and the confident wording is kept only
                  for the case that earns it. */}
              <Stat label="Cost"
                    value={!totals || !costStatus ? '—'
                      : costStatus.kind === 'unreported' ? '—' : costStatus.kind === 'partial' ? `≥ ${usd(totals.cost)}` : usd(totals.cost)}
                    sub={!totals || !costStatus ? rowsUnread
                      : costStatus.kind === 'unreported'
                        ? 'no repository reported a cost, so there is no figure to show'
                        : costStatus.kind === 'partial'
                          ? `a floor · ${num(costStatus.missing)} ${costStatus.missing === 1 ? 'repository' : 'repositories'} reported no cost`
                          : 'CLI-reported; never estimated'} />
            </div>
            {/* The rows region answers for its own read. A run's repositories
                are shown under that run's name or not at all, so "reading" and
                "could not read" live here rather than leaving the last run's
                table standing under this one's heading. */}
            {readRows === null ? (
              !rowsFor?.error
                ? <Reading what="this run's repositories" />
                : <EmptyState posture="could-not-read" title="Could not read this run's repositories"
                              cue={`${rowsFor.error} · the run and its worktrees are untouched; only this read failed.`}
                              action={<button className="btn" onClick={() => setRowsNonce((n) => n + 1)}>Try again</button>} />
            ) : readRows.length === 0 ? (
              <EmptyState posture="nothing-yet" title="No repositories on this run"
                          cue="The read returned, and this run has no repository rows recorded against it." />
            ) : <>
              {/* Rows for this run, plus a failed re-read of the same run. They
                  are not another run's rows, so they stay; what they cannot do
                  is pass for the current state of the run. */}
              {rowsFor?.error && (
                <Note tone="warn">The last re-read of this run's repositories failed: {rowsFor.error}. The rows
                  below are from the read that returned before it, so their status may have moved on.</Note>
              )}
              <div className="hr-rows">{readRows.map((row) => {
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
          </>}
        </section>
      </div>
    </main>
  );
}
