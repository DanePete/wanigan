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
   and a job pinned to the top of the hour is a job competing with every other.
   The labels name the minute each one really fires: this view's whole claim is
   that a schedule can be audited, and a label that rounds 03:03 to 03:00 is the
   first thing to check and the first thing to be wrong. */
const PRESETS: { label: string; cron: string }[] = [
  { label: 'every 15 min', cron: '*/15 * * * *' },
  { label: 'hourly at :07', cron: '7 * * * *' },
  { label: 'nightly 03:03', cron: '3 3 * * *' },
  { label: 'weekday mornings 09:07', cron: '7 9 * * 1-5' },
  { label: 'Monday 08:07', cron: '7 8 * * 1' },
];

/* What a recorded fire came to, and how honest each answer is.
   Everything except 'failed' used to render as either nothing at all (in the
   row) or a green tick (in the history), so a fire still sitting in the queue,
   and one nothing ever reported back on, both read as a success. They are the
   two states an operator most needs to tell apart from one. */
const OUTCOME: Record<string, { glyph: string; text: string; tone: string }> = {
  ok: { glyph: '✓', text: 'last fire ok', tone: 'var(--good)' },
  failed: { glyph: '✕', text: 'failed', tone: 'var(--bad)' },
  queued: { glyph: '◷', text: 'queued — nothing has picked it up yet', tone: 'var(--warning)' },
  dispatching: { glyph: '▸', text: 'dispatching', tone: 'var(--accent)' },
  running: { glyph: '▸', text: 'running', tone: 'var(--accent)' },
  skipped: { glyph: '·', text: 'skipped', tone: 'var(--text-dim)' },
  canceled: { glyph: '·', text: 'canceled', tone: 'var(--text-dim)' },
  unknown: { glyph: '?', text: 'no outcome was recorded', tone: 'var(--warning)' },
};
/* A status this build has never heard of is reported as itself, in the tone
   that claims the least. */
const outcome = (status: string) => OUTCOME[status] ?? { glyph: '·', text: status, tone: 'var(--text-dim)' };

const when = (t: number | null) => (t === null ? '—' : new Date(t).toLocaleString(undefined, {
  weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric',
}));

/* What one scheduled fire is capped at, per repository.

   The ceiling itself is SCHEDULED_BUDGET_USD in src/main/index.ts, handed to
   the CLI as --max-budget-usd. No IPC channel reports it, so this is a mirror
   and has to be changed with it. It is mirrored rather than left out because a
   fan-out has to be able to say what it will cost BEFORE it is saved, and a
   blast radius with no number is a warning nobody can size. It is a ceiling
   the run is held to, not an estimate of what a run will spend. */
const PER_REPO_BUDGET_USD = 2;

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

/**
 * Whether a headless schedule says out loud that it means every repository.
 *
 * A schedule with no project pinned is expanded to the whole registered list at
 * fire time, and by then a run across every repository someone has ever added
 * is the same array as one they chose repository by repository. So the runner
 * carries an explicit `allProjects` through and refuses the fan-out without it.
 *
 * Rows written before that flag existed carry a bare `{ prompt }` and read
 * false here, which is what lets the list say they need attention instead of
 * leaving them to fail at 03:00 with nobody watching.
 */
function declaresAllProjects(p: unknown): boolean {
  return !!p && typeof p === 'object' && (p as { allProjects?: unknown }).allProjects === true;
}

/* Naming the repositories is the point of a blast radius, but a list of forty
   is a wall nobody reads and the count is what carries the size. */
const namesOf = (projects: Project[], cap = 6): string =>
  projects.length <= cap
    ? projects.map((p) => p.name).join(', ')
    : `${projects.slice(0, cap).map((p) => p.name).join(', ')} and ${projects.length - cap} more`;

export default function Schedules({ projects }: { projects: Project[] }) {
  const [list, setList] = useState<Schedule[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [cron, setCron] = useState('3 3 * * *');
  const [kind, setKind] = useState<Kind>('headless');
  const [projectId, setProjectId] = useState('');
  // Deliberately not defaulted to true. The whole point of the flag is that
  // nothing but a person can set it.
  const [allProjects, setAllProjects] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [rerunId, setRerunId] = useState('');
  const [runs, setRuns] = useState<RunOption[]>([]);
  const [runsErr, setRunsErr] = useState<string | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ fires: number[]; describe: string } | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [hist, setHist] = useState<Record<string, { at: number; status: string; detail: string | null }[]>>({});
  const [histErr, setHistErr] = useState<Record<string, string>>({});
  const [daemon, setDaemon] = useState<{ supported: boolean; installed: boolean; detail: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setList(await window.wanigan.schedule.list()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    // The cap lives in Settings and there is no settings-changed channel, so
    // reading it once per view mount left this screen quoting a cap the user
    // had already lowered. It rides the same beat as the list instead. Its own
    // try: a settings read that fails must not blank the schedule list.
    try { setCap((await window.wanigan.settings.get()).spendCapUsd); }
    catch { /* the cap shown here is a warning; submit.ts holds the real one */ }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { void window.wanigan.schedule.daemon().then(setDaemon).catch(() => {}); }, []);

  /* The scheduler ticks every 20 seconds, and a fire that came due while
     Wanigan was closed waits for the first tick after it opens. This runs that
     tick now. It cannot pull a schedule forward past its own window — nothing
     in the IPC surface can — so it says which of the two happened rather than
     letting an empty result read as a broken button. */
  async function runDue() {
    setChecking(true); setChecked(null);
    try {
      const fired = await window.wanigan.schedule.tick();
      await load();
      setChecked(fired === 0
        ? 'Nothing started: nothing was due, or the scheduler was already mid-tick. A schedule is never pulled forward past its own window.'
        : `Started ${fired} fire${fired === 1 ? '' : 's'} — open History on a schedule for what it came to.`);
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setChecking(false); }
  }

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
    })();
    return () => { live = false; };
  }, [kind]);

  const chosen = runs.find((r) => r.id === rerunId) ?? null;
  // Only claimed when the run's settled cost is already over the cap: the cap is
  // checked against the ceiling of a fresh estimate, so a run that has actually
  // billed more than the cap cannot come in under it by accident. The reverse
  // inference would be a false green.
  const overCap = chosen !== null && cap !== null && cap > 0 && chosen.cost_usd > cap;

  /* A headless schedule with no repository pinned is a fan-out across the whole
     registered list, now and every project added after it. That is the one
     selection nothing downstream can tell apart from an accident, so this form
     is where it is either declared or refused. A batch re-run ignores the
     project entirely — it submits the run's own config — so none of this
     applies to it. */
  const unpinned = kind === 'headless' && !projectId;
  const fanOut = unpinned && allProjects;
  const noRepos = unpinned && projects.length === 0;
  const needsIntent = unpinned && projects.length > 0 && !allProjects;
  const fanOutCeilingUsd = PER_REPO_BUDGET_USD * projects.length;

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
        //
        // `allProjects` is stored on the schedule rather than decided when it
        // fires: it is the operator's declaration, and the fire happens with
        // nobody there to make one. It is written only for a schedule that
        // really is unpinned, so a pinned row cannot carry a claim about a
        // fan-out it will never do.
        payload: target
          ? { runId: target.id, runName: target.name }
          : { prompt: prompt.trim(), allProjects: fanOut },
        projectId: projectId || null,
      });
      setName(''); setPrompt(''); setRerunId(''); setAllProjects(false);
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
    setHistErr((h) => { const n = { ...h }; delete n[s.id]; return n; });
    try {
      const rows = await window.wanigan.schedule.history(s.id, 8);
      setHist((h) => ({ ...h, [s.id]: rows }));
    } catch (e) {
      // A schedule that has never fired resolves with zero rows and renders
      // "Never fired yet." A read that failed is a different thing, and
      // swallowing it made the History button look like a dead control.
      setHistErr((h) => ({ ...h, [s.id]: e instanceof Error ? e.message : String(e) }));
    }
  }

  const live = list.filter((s) => s.enabled);
  const nextUp = live.filter((s) => s.nextAt).sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0))[0];

  /* Saved before the fan-out had to be declared, so nothing in the row says
     what it meant. Counted at the top because the rows that carry it can be
     anywhere in a long list, and a schedule that will refuse at 03:00 is worth
     finding at 14:00. */
  const undeclared = list.filter((s) => s.kind === 'headless' && !s.projectId && !declaresAllProjects(s.payload));

  // Worst last word across every schedule, in the order an operator cares
  // about. A failure outranks a fire nobody answered for, which outranks a
  // clean one — and never having fired is not a clean one.
  const firstWith = (status: string) => list.find((s) => s.lastStatus === status) ?? null;
  const failed = firstWith('failed');
  const unreported = firstWith('unknown');
  const settled = firstWith('ok');
  const worst = failed
    ? { value: 'failed', tone: 'var(--bad)', sub: failed.name }
    : unreported
      ? { value: 'unreported', tone: 'var(--warning)', sub: `${unreported.name} — dispatched, no outcome recorded` }
      : settled
        ? { value: 'ok', tone: undefined, sub: settled.name }
        : { value: '—', tone: undefined, sub: list.length ? 'no fire has reported an outcome yet' : 'nothing scheduled' };

  return (
    <div className="sc-wrap">
      <div className="sc-head">
        <h1>Schedules</h1>
        <span className="n">{live.length} running · {list.length - live.length} paused</span>
      </div>

      <p className="dim" style={{ maxWidth: '74ch', marginTop: 6, lineHeight: 1.55 }}>
        A schedule is a row in your database, not a timer inside a session: it survives a quit and never expires.
        While Wanigan is open, its own ticker fires whatever is due. With the background scheduler installed it
        keeps firing with Wanigan closed — macOS starts the same app at login with no window, sharing this
        database. Without it, anything that came due while Wanigan was closed fires once when you next open it,
        not once for every tick that was missed. Claude Code's <span className="mono">/loop</span> lasts only as
        long as its session and deletes itself after seven days; that is the right call for a terminal and the
        wrong one for a machine you leave running.
      </p>

      {daemon && (
        <div className="sunk" style={{ marginTop: 10, padding: '9px 11px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', maxWidth: '74ch' }}>
          <span className="faint">{daemon.detail}</span>
          {daemon.supported && <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => void toggleDaemon(!daemon.installed)}>
            {daemon.installed ? 'Stop background scheduler' : 'Fire schedules while Wanigan is closed'}
          </button>}
        </div>
      )}

      <div className="sc-actions" style={{ marginTop: 10, alignItems: 'center' }}>
        <button className="btn" disabled={checking} onClick={() => void runDue()}>
          {checking ? 'Checking…' : 'Run anything due now'}
        </button>
        <span className="faint" role="status" style={{ fontSize: 'var(--t-small)', lineHeight: 1.45, maxWidth: '58ch' }}>
          {checked ?? 'Runs the tick immediately instead of waiting up to 20 seconds for the next one. A schedule that is not due yet is not pulled forward.'}
        </span>
      </div>

      {err && <div style={{ marginTop: 10 }}><Note tone="error">{err}</Note></div>}

      {undeclared.length > 0 && (
        <div style={{ marginTop: 10, maxWidth: '74ch' }}>
          <Note tone="warn">
            <span aria-hidden="true">⚠ </span>
            {undeclared.length === 1 ? 'One schedule pins no repository' : `${undeclared.length} schedules pin no repository`}
            {' '}and {undeclared.length === 1 ? 'does' : 'do'} not say {undeclared.length === 1 ? 'it' : 'they'} meant
            every registered one: {undeclared.map((s) => s.name).join(', ')}.
            {projects.length > 1
              ? ` Running an unattended agent across all ${projects.length} of your repositories now has to be asked`
                + ' for, so every fire is refused until each is recreated.'
              : ' Fanning out across every repository now has to be asked for, so each will be refused once you'
                + ' register a second repository.'}
            {' '}Each row below says what to do about it.
          </Note>
        </div>
      )}

      <div className="stat-grid" style={{ marginTop: 12 }}>
        <Stat label="Running" value={num(live.length)}
              sub={daemon?.installed ? 'counting down whether Wanigan is open or not' : 'counting down while Wanigan is open'} />
        <Stat label="Next fire" value={nextUp ? when(nextUp.nextAt) : '—'} sub={nextUp?.name ?? 'nothing scheduled'} />
        <Stat label="Total runs" value={num(list.reduce((a, s) => a + s.runs, 0))} sub="since you created them" />
        {/* Unattended runs now write a real terminal status back onto the fire
            they were spent on, so this reads those. 'ok' is claimed only when a
            fire actually finished well: one nothing ever reported back on, and a
            schedule that has never fired, are each said as themselves. */}
        <Stat label="Last outcome" value={worst.value} tone={worst.tone} sub={worst.sub} />
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
            {/* "Every project" read like a convenience. It is a fan-out across
                every repository registered now and every one added later, at a
                budget per repository, so it says what it does. */}
            <select className="field" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Every registered repository</option>
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
            <p className="faint" style={{ fontSize: 'var(--t-small)', lineHeight: 1.5 }}>
              Every fire starts an unattended agent with this prompt and nothing else typed. What it is told
              before that — the CLAUDE.md chain, memory, rules, hooks and their token cost — is the Context
              view (<span className="mono">⌘⇧C</span>, or ⌘K → Context).
            </p>

            {/* The blast radius, before it is saved rather than after it has
                fired. `projects.length` is the registered list this view was
                handed, so the count is read, not guessed; the per-repository
                ceiling is the mirrored constant above. */}
            {unpinned && (noRepos ? (
              <Note tone="warn">
                No repository is pinned and none are registered, so every fire would fail with nothing to run
                in. Add a folder in Sessions, or pin a repository above once you have one.
              </Note>
            ) : (
              <div className="sc-preview sunk" style={{ padding: '10px 12px' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input type="checkbox" checked={allProjects} style={{ marginTop: 2 }}
                         onChange={(e) => setAllProjects(e.target.checked)} />
                  <span>
                    <strong>Run in every registered repository.</strong>{' '}
                    {projects.length > 1
                      ? <>Without this, the fire is refused before it starts.</>
                      : <>Without this, the fire is refused as soon as a second repository is registered.</>}
                  </span>
                </label>

                <p style={{ marginTop: 8, lineHeight: 1.5 }}>
                  {allProjects ? (
                    <>
                      Each fire starts one unattended agent in{' '}
                      <strong>{projects.length === 1
                        ? 'your 1 registered repository'
                        : `all ${projects.length} registered repositories`}</strong>{' '}
                      — {namesOf(projects)} — each held to the {usd(PER_REPO_BUDGET_USD)} per-repository
                      ceiling Wanigan hands the CLI, so one fire is capped at {usd(fanOutCeilingUsd)} across
                      the fan-out. Registering another project widens this on its own; nothing asks again.
                    </>
                  ) : (
                    <>
                      A schedule with no repository pinned means every repository you have registered, now and
                      every one added later. A payload that leaves the repository out arrives at the runner
                      looking exactly like one that meant a single repo, so the intent has to be said here.
                      {projects.length > 1
                        ? ` Right now that is all ${projects.length} of them, at ${usd(PER_REPO_BUDGET_USD)} per repository.`
                        : ` Right now that is your one repository, at ${usd(PER_REPO_BUDGET_USD)} for the fire.`}
                      {' '}Tick the box, or pin a repository above.
                    </>
                  )}
                </p>
              </div>
            ))}
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
          {/* An empty prompt, an unpicked run and an undeclared fan-out all make
              a schedule that can only fail on its first fire, hours after the
              person who wrote it has stopped looking at this screen. */}
          <button className="btn btn-primary"
                  disabled={busy || !preview?.fires.length || needsIntent || noRepos
                            || (kind === 'batch' ? !chosen : !prompt.trim())}
                  onClick={() => void create()}>
            {busy ? 'Creating…' : fanOut && projects.length > 1
              ? `Create schedule — ${projects.length} repositories per fire`
              : 'Create schedule'}
          </button>
          {needsIntent && (
            <span className="faint" style={{ marginLeft: 10, fontSize: 'var(--t-small)' }}>
              Pin a repository, or tick “run in every registered repository”.
            </span>
          )}
        </div>
      </div>

      {list.length === 0 ? (
        <p className="faint" style={{ marginTop: 18, maxWidth: '64ch', lineHeight: 1.55 }}>
          Nothing scheduled. Two are worth having first: a nightly headless run — pinned to one repository, or
          across every registered one if you ask for that explicitly — and a batch you have already read the
          results of, re-submitted overnight at half the synchronous price.
        </p>
      ) : (
        <div className="sc-list">
          {list.map((s) => {
            // The row's own last word. Reading it from the same table as the
            // history means a schedule cannot look armed here and queued there.
            const last = s.lastStatus ? outcome(s.lastStatus) : null;
            const target = s.kind === 'batch' ? batchTarget(s.payload) : null;
            // Unpinned headless rows are the ones the blast-radius gate acts
            // on. Split into "declared" and "never declared" here so the list
            // can show the first as a fan-out and the second as needing work.
            const fansOut = s.kind === 'headless' && !s.projectId;
            const declared = fansOut && declaresAllProjects(s.payload);
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
                  {last && (
                    <span style={{ color: last.tone }}>
                      <span aria-hidden="true">{last.glyph} </span>{last.text}
                      {/* The detail is why a fire failed, was skipped, or was
                          never answered for. On a clean one it is boilerplate
                          about the run that already carries the outcome. */}
                      {s.lastStatus !== 'ok' && s.lastDetail ? ` — ${s.lastDetail}` : ''}
                    </span>
                  )}
                  {s.projectId && <span>{projects.find((p) => p.id === s.projectId)?.name ?? s.projectId}</span>}
                  {/* Blast radius belongs on the row, not only in the form:
                      this is the line that says a nightly job touches ten
                      repositories rather than the one you were thinking of. */}
                  {declared && (
                    <span>every registered repository{projects.length ? ` — ${projects.length} today` : ''}</span>
                  )}
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
                {/* The behaviour change made visible. This schedule used to fan
                    out across every repository silently; a fan-out now has to
                    be declared, and one written before that flag existed has no
                    declaration to read. Saying so here beats a row that looks
                    armed until 03:00 and then reports a blast-radius refusal. */}
                {fansOut && !declared && (
                  <Note tone="warn">
                    <strong>Needs attention:</strong> no repository is pinned, and nothing in this schedule says it
                    meant every registered repository.
                    {projects.length === 0
                      ? ' There are none registered either, so every fire fails with nothing to run in.'
                      : projects.length === 1
                        ? ' It still fires today against your one registered repository. Register a second and every'
                          + ' fire is refused instead: an unpinned schedule means every repository, and that is no'
                          + ' longer inferred from an empty field.'
                        : ` Every fire is now refused before it starts — it would run an unattended agent in all`
                          + ` ${projects.length} of your registered repositories, and a payload that leaves the`
                          + ` repository out cannot be told apart from one that meant a single repo.`}
                    {' '}A saved schedule cannot be edited: delete this one and create it again, either pinned to a
                    repository or with “run in every registered repository” ticked.
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
                {histErr[s.id] && (
                  <Note tone="error">
                    Could not read this schedule's fire history. {histErr[s.id]} Press History again to retry —
                    the schedule itself is unaffected.
                  </Note>
                )}
                {hist[s.id] && (
                  <div className="sc-hist">
                    {hist[s.id].length === 0
                      ? <div>Never fired yet.</div>
                      : hist[s.id].map((h, i) => {
                        // A fire that was skipped, cancelled, still queued or
                        // never reported on did not succeed; a green tick on
                        // any of them reports work that never happened.
                        const o = outcome(h.status);
                        return (
                          <div key={i}>
                            <span style={{ width: 130 }}>{when(h.at)}</span>
                            <span style={{ color: o.tone }}>{o.glyph} {h.status}</span>
                            {h.detail && <span>{h.detail}</span>}
                          </div>
                        );
                      })}
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
