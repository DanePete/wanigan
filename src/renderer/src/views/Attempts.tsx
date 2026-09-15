import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, ProviderInfo } from '@shared/types';
import {
  PASS_FORM_WORDS, ceilingWords, isTrialStatus, planAttempts,
  type AttemptArmInput, type AttemptCleanupOutcome, type AttemptCleanupResult, type AttemptGate, type AttemptRow,
  type AttemptSetDetail, type AttemptSetKind, type AttemptSetSummary, type CostPerSolved, type PassFigure,
} from '@shared/attempts';
import { oracleSentence } from '@shared/test-oracles';
import {
  ConfirmNote, EmptyState, Explainer, Hint, Mark, Note, PageHead, Reading, SectionHead, Segmented, Stat, ago, dur, num, usd,
  type MarkSpec,
} from '../components/bits';
import { useLiveViewMemory } from '../components/planningMemory';
import '../styles/attempts.css';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const TIMEOUTS = [5, 15, 30, 60] as const;
const REPEATS = Array.from({ length: 10 }, (_, i) => i + 1);
const plural = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;

type ArmDraft = { providerId: string; model: string; effort: string };

/** A set's detail, and the set it was read for; see RowsState in HeadlessRuns for why the id travels. */
type DetailState = { setId: string; detail: AttemptSetDetail | null; error: string | null };

const KIND_WORDS: Record<AttemptSetKind, string> = { 'best-of-n': 'Best of N', bench: 'Paired bench' };

const GATE_MARKS: Record<AttemptGate, MarkSpec> = {
  running: { glyph: '▸', word: 'gating', tone: 'quiet' },
  passed: { glyph: '✓', word: 'passed', tone: 'ok' },
  failed: { glyph: '✕', word: 'failed', tone: 'serious' },
  'not-run': { glyph: '–', word: 'not gated', tone: 'dead' },
  unavailable: { glyph: '?', word: 'gate unavailable', tone: 'warn' },
};

const OUTCOME_MARKS: Record<AttemptCleanupOutcome, MarkSpec> = {
  removed: { glyph: '✓', word: 'removed', tone: 'ok' },
  kept: { glyph: '■', word: 'kept', tone: 'warn' },
  gone: { glyph: '–', word: 'already gone', tone: 'dead' },
  refused: { glyph: '✕', word: 'refused', tone: 'serious' },
};

/** The run's own state while an attempt is queued, and its outcome once recorded. */
function statusMark(row: AttemptRow): MarkSpec {
  if (row.status === 'queued') {
    if (row.liveStatus === 'running') return { glyph: '▸', word: 'running', tone: 'quiet' };
    if (row.liveStatus === 'awaiting') return { glyph: '⏸', word: 'waiting for you', tone: 'warn' };
    if (row.liveStatus === 'pending') return { glyph: '○', word: 'queued', tone: 'quiet' };
    return { glyph: '◦', word: 'recording', tone: 'quiet' };
  }
  switch (row.status) {
    case 'succeeded': return { glyph: '•', word: 'agent finished', tone: 'quiet' };
    case 'errored': return { glyph: '✕', word: 'agent errored', tone: 'serious' };
    case 'timeout': return { glyph: '✕', word: 'timed out', tone: 'serious' };
    case 'blocked': return { glyph: '■', word: 'blocked', tone: 'serious' };
    case 'canceled': return { glyph: '⊘', word: 'canceled', tone: 'serious' };
    case 'failed-to-start': return { glyph: '✕', word: 'never started', tone: 'serious' };
    default: return { glyph: '?', word: 'not recorded', tone: 'warn' };
  }
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

function Figure({ figure }: { figure: PassFigure }) {
  if (figure.value === null) return <span className="at-figure"><span>—</span><small>{figure.reason}</small></span>;
  return <span className="at-figure"><span>{percent(figure.value)}</span></span>;
}

function CostPerSolvedCell({ cost }: { cost: CostPerSolved }) {
  const reported = `${cost.reported} of ${cost.trials} reported`;
  if (cost.usd === null) return <span className="at-figure"><span>—</span><small>{cost.reason} · {reported}</small></span>;
  return (
    <span className="at-figure">
      <span>{cost.floor ? `≥ ${usd(cost.usd)}` : usd(cost.usd)}</span>
      <small>{reported}{cost.reason ? ` · ${cost.reason}` : ''}</small>
    </span>
  );
}

function costWords(row: AttemptRow): string {
  if (row.status === 'queued') return '—';
  return row.costReported === true && row.costUsd !== null ? usd(row.costUsd) : 'not reported';
}

function tokenWords(row: AttemptRow): string | null {
  if (row.status === 'queued') return null;
  if (!row.tokens) return 'no token counts reported';
  const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : num(n));
  return `${k(row.tokens.input)} in · ${k(row.tokens.output)} out · ${k(row.tokens.cacheRead)} cache read`;
}

function OracleCell({ row }: { row: AttemptRow }) {
  if (row.status === 'queued' || row.gate === 'running') return <span className="faint">—</span>;
  if (!isTrialStatus(row.status)) return <span className="faint">not read: no run of its own</span>;
  if (!row.oracle) return <span className="faint">not recorded</span>;
  if (!row.oracle.reading) return <span className="at-note">Could not be read: {row.oracle.note ?? 'no reason was recorded.'}</span>;
  if (!row.oracle.reading.flags.length) return <span className="faint">none flagged</span>;
  return <ul className="at-flags">{row.oracle.reading.flags.map((flag, i) => <li key={i}>{oracleSentence(flag)}</li>)}</ul>;
}

/**
 * Attempts, beside headless runs: one task run several times from one pinned
 * commit, read as a comparison a person decides on, or as a bench report.
 *
 * Every figure on it comes from main, computed over what the attempts
 * recorded. This file adds words and never arithmetic, so a number here cannot
 * disagree with the one the smoke suite checks.
 */
export default function Attempts({ projects, providers, areaSwitch }: {
  projects: Project[]; providers: ProviderInfo[]; areaSwitch: React.ReactNode;
}) {
  const [sets, setSets] = useState<AttemptSetSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [selected, setSelected] = useLiveViewMemory<string | null>('attemptSelected', null);
  const [composing, setComposing] = useLiveViewMemory('attemptComposer', false);
  const [detailState, setDetailState] = useState<DetailState | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);
  const [kind, setKind] = useLiveViewMemory<AttemptSetKind>('attemptKind', 'best-of-n');
  const [projectId, setProjectId] = useLiveViewMemory('attemptProject', '');
  const [prompt, setPrompt] = useLiveViewMemory('attemptPrompt', '');
  const [arms, setArms] = useLiveViewMemory<ArmDraft[]>('attemptArms', [{ providerId: '', model: '', effort: '' }]);
  const [repeats, setRepeats] = useLiveViewMemory<number>('attemptRepeats', 3);
  const [budget, setBudget] = useLiveViewMemory('attemptBudget', '2');
  const [minutes, setMinutes] = useLiveViewMemory<number>('attemptMinutes', 15);
  const [holdForApproval, setHoldForApproval] = useLiveViewMemory('attemptHold', false);
  const [busy, setBusy] = useLiveViewMemory<string | null>('attemptBusy', null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState<string | null>(null);
  const [cleanupResult, setCleanupResult] = useState<AttemptCleanupResult | null>(null);
  const active = useRef(true), readSequence = useRef(0), actionLock = useRef(false);
  const reader = useRef<HTMLElement>(null);
  // A different set opens at its top, not at whatever depth the last one was read to.
  useEffect(() => { reader.current?.scrollTo({ top: 0 }); }, [selected]);
  // `active` alone retires a read that outlives this view; the sequence only
  // orders reads against each other while it is mounted.
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const load = useCallback(async () => {
    const sequence = ++readSequence.current;
    try {
      const next = await window.wanigan.attempts.sets(50);
      if (!active.current || sequence !== readSequence.current) return;
      setSets(next);
      setSelected((old) => (old && next.some((s) => s.id === old) ? old : (next[0]?.id ?? null)));
      setLoaded(true);
      setLoadFailed(null);
    } catch (error) {
      if (active.current && sequence === readSequence.current) setLoadFailed(msg(error));
    }
  }, [setSelected]);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 3000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  useEffect(() => {
    if (!selected) { setDetailState(null); return; }
    let alive = true;
    const setId = selected;
    // The previous set's detail goes on the selection change, so a failed read
    // for this set can never leave another set's attempts under its title.
    setDetailState((prior) => (prior && prior.setId === setId ? (prior.error === null ? prior : { ...prior, error: null }) : { setId, detail: null, error: null }));
    const read = () => window.wanigan.attempts.set(setId)
      .then((detail) => { if (alive) setDetailState({ setId, detail, error: null }); })
      .catch((error: unknown) => {
        if (alive) setDetailState((prior) => (prior && prior.setId === setId ? { ...prior, error: msg(error) } : prior));
      });
    void read();
    const t = setInterval(() => { if (!document.hidden) void read(); }, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [selected, detailNonce]);

  useEffect(() => { setConfirmCleanup(null); }, [selected]);

  /* ── the form ─────────────────────────────────────────────────────── */
  const installed = providers.filter((p) => p.path && p.capabilities.headlessJson);
  const armInputs: AttemptArmInput[] = arms.map((arm) => ({
    providerId: arm.providerId, model: arm.model.trim() || null, effort: arm.effort.trim() || null,
  }));
  const budgetUsd = budget.trim() === '' ? undefined : Number(budget);
  const planned = planAttempts({ kind, prompt, arms: armInputs, repeats, budgetUsd, timeoutMs: minutes * 60_000 });
  const project = projects.find((p) => p.id === projectId) ?? null;
  const missingProvider = arms.findIndex((arm) => !installed.some((p) => p.id === arm.providerId));
  const armFacts = arms.map((arm) => {
    const provider = providers.find((p) => p.id === arm.providerId);
    return { label: provider?.label ?? arm.providerId, budgetFlag: provider?.capabilities.headlessBudget !== false };
  });
  const blocker = !project ? 'Choose the project the attempts run in.'
    : missingProvider >= 0 ? `Choose an installed provider with headless support for arm ${missingProvider + 1}.`
      : !planned.ok ? planned.reason : null;
  const attemptCount = arms.length * repeats;

  const updateArm = (index: number, patch: Partial<ArmDraft>) =>
    setArms((prior) => prior.map((arm, i) => (i === index ? { ...arm, ...patch } : arm)));
  const chooseKind = (next: AttemptSetKind) => {
    setKind(next);
    // A bench compares arms, so it opens with a second one to fill in; best of
    // N is usually one arm tried several times. Neither overwrites arms a person
    // has already added.
    setArms((prior) => (next === 'bench' && prior.length === 1 ? [...prior, { providerId: '', model: '', effort: '' }] : prior));
    setConfirmStart(false);
  };

  async function start() {
    if (blocker || actionLock.current || !planned.ok || !project) return;
    actionLock.current = true; setBusy('start'); setErr(null);
    try {
      const detail = await window.wanigan.attempts.start({
        kind, projectId: project.id, prompt: planned.plan.prompt, arms: planned.plan.arms, repeats: planned.plan.repeats,
        budgetUsd: planned.plan.budgetUsd, timeoutMs: planned.plan.timeoutMs, holdForApproval,
      });
      setConfirmStart(false); setComposing(false); setPrompt(''); setSelected(detail.id);
      setDetailState({ setId: detail.id, detail, error: null });
      void load();
    } catch (error) {
      setConfirmStart(false);
      setErr(msg(error));
    } finally { actionLock.current = false; setBusy(null); }
  }

  async function keep(setId: string, attemptId: string) {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(`keep-${attemptId}`); setErr(null);
    try {
      const detail = await window.wanigan.attempts.keep(setId, attemptId);
      setDetailState({ setId, detail, error: null });
      void load();
    } catch (error) { setErr(msg(error)); }
    finally { actionLock.current = false; setBusy(null); }
  }

  async function removeOthers(setId: string) {
    if (actionLock.current) return;
    actionLock.current = true; setBusy('cleanup'); setErr(null);
    try {
      const result = await window.wanigan.attempts.removeOthers(setId);
      setCleanupResult(result); setConfirmCleanup(null); setDetailNonce((n) => n + 1);
    } catch (error) { setErr(msg(error)); }
    finally { actionLock.current = false; setBusy(null); }
  }

  const current = detailState && detailState.setId === selected ? detailState : null;

  return (
    <>
      <PageHead title="Runs" lead={composing ? 'One task, several attempts, one pinned commit.' : 'The same task run several times, compared by what each run recorded.'}
                actions={<>
                  {!composing && areaSwitch}
                  {composing
                    ? <button className="btn" disabled={busy === 'start'} onClick={() => { setComposing(false); setConfirmStart(false); }}>Back to attempts</button>
                    : <button className="btn btn-primary" onClick={() => { setComposing(true); setErr(null); }}>New attempt set</button>}
                </>} />
      {err && <Note tone="error">{err}</Note>}

      {composing ? (
        <fieldset className="at-compose" disabled={busy === 'start'}>
          <section className="at-launch" aria-labelledby="attempts-launch-title">
            <SectionHead label="The task" />
            <h2 id="attempts-launch-title">One task, tried more than once.</h2>
            <Explainer id="attempts-intro" title="What an attempt set is">
              Every attempt is its own headless run, in its own worktree cut from the commit the project is on when you
              start. <strong>Best of N</strong> puts the attempts side by side for you to keep one. A <strong>paired bench</strong> gives
              each arm the same number of tries and reports pass@k (at least one of k passes) and pass^k (all k pass). They
              answer different questions: at 70% per try, pass@3 is 97.3% and pass^3 is 34.3%.
            </Explainer>
            <Segmented label="Kind of set" value={kind} onChange={chooseKind}
                       options={[{ value: 'best-of-n', label: 'Best of N' }, { value: 'bench', label: 'Paired bench' }]} />
            <div className="at-form-grid">
              <label className="at-field"><span className="label">Project</span>
                <select className="field" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">Choose a project…</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label className="at-field"><span className="label">Repeats per arm</span>
                <select className="field" value={repeats} onChange={(e) => setRepeats(Number(e.target.value))}>
                  {REPEATS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>
            <label className="at-field at-prompt"><span className="label">Task for every attempt</span>
              <textarea className="field" value={prompt} onChange={(e) => setPrompt(e.target.value)}
                        placeholder="Make the retry test pass without charging twice, and run the checkout suite." />
            </label>
            <div className="at-arms" role="group" aria-label="Arms">
              <SectionHead label="Arms" count={arms.length} right={
                <button className="btn btn-sm" disabled={arms.length >= 4} onClick={() => setArms((prior) => [...prior, { providerId: '', model: '', effort: '' }])}>Add arm</button>
              } />
              {arms.map((arm, index) => (
                <div className="at-arm" key={index}>
                  <span className="at-arm-n" aria-hidden="true">{index + 1}</span>
                  <label className="at-field"><span className="label">Provider</span>
                    <select className="field" aria-label={`Arm ${index + 1} provider`} value={arm.providerId} onChange={(e) => updateArm(index, { providerId: e.target.value })}>
                      <option value="">Choose…</option>
                      {installed.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                  </label>
                  <label className="at-field"><span className="label">Model</span>
                    <input className="field" aria-label={`Arm ${index + 1} model`} value={arm.model} placeholder="Provider default"
                           onChange={(e) => updateArm(index, { model: e.target.value })} />
                  </label>
                  <label className="at-field"><span className="label">Effort</span>
                    <input className="field" aria-label={`Arm ${index + 1} effort`} value={arm.effort} placeholder="Default"
                           onChange={(e) => updateArm(index, { effort: e.target.value })} />
                  </label>
                  <button className="btn btn-sm" disabled={arms.length <= 1} onClick={() => setArms((prior) => prior.filter((_, i) => i !== index))}>Remove</button>
                </div>
              ))}
            </div>
          </section>
          <aside className="at-launch-side" aria-label="Spending and start">
            <SectionHead label="Spending" />
            <h2>{plural(attemptCount, 'attempt')}{project ? ` in ${project.name}` : ''}.</h2>
            <label className="at-field"><span className="label">Budget per attempt · USD</span>
              <input className="field" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </label>
            <label className="at-field"><span className="label">Timeout per attempt</span>
              <select className="field" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                {TIMEOUTS.map((m) => <option key={m} value={m}>{m} minutes</option>)}
              </select>
            </label>
            <label className="at-check"><input type="checkbox" checked={holdForApproval} onChange={(e) => setHoldForApproval(e.target.checked)} /> hold approvals for me</label>
            {/* The ceiling in words, from the same function main plans with, so the
                sentence cannot promise a limit the launch will not pass. */}
            <p className="at-ceiling" aria-live="polite">
              {planned.ok ? ceilingWords({ budgetUsd: planned.plan.budgetUsd, timeoutMs: planned.plan.timeoutMs, repeats: planned.plan.repeats, arms: armFacts }) : blocker}
            </p>
            {!blocker && !confirmStart && (
              <button className="btn btn-primary" onClick={() => setConfirmStart(true)}>Start {plural(attemptCount, 'attempt')}…</button>
            )}
            {blocker && <Hint>Start stays off until this is settled.</Hint>}
            {!blocker && confirmStart && planned.ok && project && (
              <ConfirmNote verb="Start attempts" busy={busy === 'start'} onRun={start} onCancel={() => setConfirmStart(false)}
                what={<>Starting lets {plural(attemptCount, 'agent')} spend money with nobody watching. Each works on this task in its own
                  worktree in <strong>{project.name}</strong>, cut from the commit its checkout is on right now, and waits for a free
                  headless slot like any run. {ceilingWords({ budgetUsd: planned.plan.budgetUsd, timeoutMs: planned.plan.timeoutMs, repeats: planned.plan.repeats, arms: armFacts })}{' '}
                  When each one ends, the project&apos;s review commands run in its worktree. Nothing is merged.</>} />
            )}
          </aside>
        </fieldset>
      ) : (
        <div className="at-workspace">
          <section className="at-history" aria-label="Attempt sets">
            <SectionHead label="Attempt sets" count={loaded ? sets.length : undefined} />
            {loaded && loadFailed && <Note tone="warn">Attempt sets could not refresh: {loadFailed}. Showing the last sets that were read.</Note>}
            <div className="at-list">
              {!loaded ? (
                loadFailed === null
                  ? <Reading what="attempt sets" />
                  : <EmptyState posture="could-not-read" title="Could not read attempt sets" cue={loadFailed}
                                action={<button className="btn" onClick={() => void load()}>Try again</button>} />
              ) : sets.length === 0 ? (
                <EmptyState posture="nothing-yet" title="No attempt sets yet"
                            cue="Run one task several times from one commit, then compare what each attempt left." />
              ) : sets.map((set) => (
                <button key={set.id} className={`at-set${set.id === selected ? ' on' : ''}`} data-set-id={set.id}
                        aria-pressed={set.id === selected} onClick={() => setSelected(set.id)}>
                  <strong>{set.title}</strong>
                  <span>{KIND_WORDS[set.kind]} · {set.projectName ?? 'removed project'} · {plural(set.attempts, 'attempt')}</span>
                  <small>{set.open > 0 ? `${num(set.open)} open` : set.status === 'failed' ? 'launch failed' : 'finished'} · {num(set.passes)} passed the gate · {ago(set.createdAt)}</small>
                </button>
              ))}
            </div>
          </section>
          <section className="at-detail" aria-label="Selected attempt set" ref={reader}>
            {!loaded ? (
              loadFailed === null ? <Reading what="the attempt sets" />
                : <EmptyState posture="could-not-read" title="No set to inspect" cue="The attempt sets could not be read. The list carries the error and a retry." />
            ) : !selected ? (
              <EmptyState posture="nothing-yet" title="No set selected" cue="Start a set when a task is worth trying more than once."
                          action={<button className="btn btn-primary" onClick={() => setComposing(true)}>Prepare a set</button>} />
            ) : !current || current.detail === null ? (
              current?.error
                ? <EmptyState posture="could-not-read" title="Could not read this set" cue={`${current.error} · its runs and worktrees are untouched; only this read failed.`}
                              action={<button className="btn" onClick={() => setDetailNonce((n) => n + 1)}>Try again</button>} />
                : <Reading what="this set's attempts" />
            ) : (
              <SetDetail detail={current.detail} readError={current.error} busy={busy} confirmCleanup={confirmCleanup === current.detail.id}
                         cleanupResult={cleanupResult?.setId === current.detail.id ? cleanupResult : null}
                         onKeep={(attemptId) => void keep(current.setId, attemptId)}
                         onAskCleanup={() => setConfirmCleanup(current.setId)} onCancelCleanup={() => setConfirmCleanup(null)}
                         onCleanup={() => removeOthers(current.setId)} />
            )}
          </section>
        </div>
      )}
    </>
  );
}

function SetDetail({ detail, readError, busy, confirmCleanup, cleanupResult, onKeep, onAskCleanup, onCancelCleanup, onCleanup }: {
  detail: AttemptSetDetail; readError: string | null; busy: string | null; confirmCleanup: boolean; cleanupResult: AttemptCleanupResult | null;
  onKeep: (attemptId: string) => void; onAskCleanup: () => void; onCancelCleanup: () => void; onCleanup: () => Promise<void>;
}) {
  const { report } = detail;
  const trials = detail.rows.filter((row) => isTrialStatus(row.status) && row.gate !== null && row.gate !== 'running');
  const priced = trials.filter((row) => row.costReported === true && row.costUsd !== null);
  const spent = priced.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const finished = detail.rows.length - report.open;
  const bestOfN = detail.kind === 'best-of-n';
  const label = (row: AttemptRow) => {
    const arm = detail.arms[row.armIndex];
    return arm ? [arm.label, arm.model, arm.effort].filter(Boolean).join(' · ') : `arm ${row.armIndex + 1}`;
  };
  const evidence: MarkSpec = report.evidence.label === 'controlled'
    ? { glyph: '✓', word: 'controlled', tone: 'ok' }
    : { glyph: '~', word: 'correlation', tone: 'warn' };

  return (
    <div className="at-reading">
      <div className="at-title">
        <Mark glyph={bestOfN ? '◇' : '▦'} word={KIND_WORDS[detail.kind]} tone="quiet" />
        <h2>{detail.title}</h2>
        <p className="faint">
          {detail.projectName ?? 'removed project'} · pinned at <span className="mono">{detail.baseCommit.slice(0, 7)}</span> ·{' '}
          {plural(detail.arms.length, 'arm')} × {detail.repeats} · {usd(detail.budgetUsd)} per attempt · {ago(detail.createdAt)}
          {detail.holdForApproval ? ' · approvals held for you' : ''}
        </p>
      </div>
      {readError && <Note tone="warn">The last re-read of this set failed: {readError}. What is below is from the read before it, so it may have moved on.</Note>}
      {detail.status === 'failed' && <Note tone="error">This set could not be launched whole. The attempts below say which one failed to start and why.</Note>}
      <div className="stat-grid at-stats">
        <Stat label="Attempts" value={`${num(finished)} of ${num(detail.rows.length)}`}
              sub={report.open ? `${plural(report.open, 'attempt')} still running or being gated` : 'none still running'} />
        <Stat label="Passed the gate" value={num(trials.filter((row) => row.gate === 'passed').length)}
              sub={`of ${plural(trials.length, 'finished trial')}`} />
        <Stat label="Cost reported"
              value={priced.length === 0 ? '—' : priced.length < trials.length ? `≥ ${usd(spent)}` : usd(spent)}
              sub={trials.length === 0 ? 'no trial has finished'
                : priced.length === 0 ? `no trial reported a cost · 0 of ${trials.length} reported`
                  : `${priced.length} of ${trials.length} reported${priced.length < trials.length ? ' · a floor' : ''}`} />
      </div>
      <details className="at-task"><summary>The task every attempt was given</summary><pre>{detail.prompt}</pre></details>
      {report.notTrials.length > 0 && (
        <p className="at-note">
          Not counted as trials: {report.notTrials.map((entry) => `${entry.count} ${entry.status}`).join(', ')}. A run someone stopped, or one that never started, says nothing about its arm.
        </p>
      )}
      {report.warnings.map((warning) => <Note key={warning} tone="warn" role="none">{warning}</Note>)}

      {!bestOfN && (
        <section className="at-report" aria-label="Bench report">
          <SectionHead label="Bench report" right={<span className="faint">k = {report.k}</span>} />
          <div className="at-scroll">
            <table className="grid at-table">
              <thead>
                <tr>
                  <th scope="col">Arm</th><th scope="col" className="r">Trials</th><th scope="col" className="r">Passed</th>
                  <th scope="col" className="r">pass@1</th>
                  <th scope="col" className="r">pass@{report.k} · estimator</th>
                  <th scope="col" className="r">pass^{report.k} · estimator</th>
                  <th scope="col">Cost per solved task</th>
                </tr>
              </thead>
              <tbody>
                {report.arms.map((arm) => (
                  <tr key={arm.armIndex} data-arm-index={arm.armIndex}>
                    <th scope="row">{arm.label}</th>
                    <td className="r">{num(arm.trials)}</td>
                    <td className="r">{num(arm.passes)}</td>
                    <td className="r"><Figure figure={arm.passAt1} /></td>
                    <td className="r"><Figure figure={arm.passAtK} /></td>
                    <td className="r"><Figure figure={arm.passHatK} /></td>
                    <td><CostPerSolvedCell cost={arm.cost} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="at-note">
            pass@{report.k} is the chance that at least one of {report.k} trials passes; pass^{report.k}, that all {report.k} do. Both
            are the {PASS_FORM_WORDS.estimator}, not a known per-trial rate. Cost per solved task divides every reported cost,
            failed trials included, by the trials that passed.
          </p>
          <div className="at-verdict">
            <div>
              <SectionHead label="Evidence" right={<Mark {...evidence} />} />
              <ul className="at-reasons">{report.evidence.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </div>
            <div>
              <SectionHead label="Lead" />
              <p className="at-lead"><strong>{report.lead.sentence}</strong></p>
              <p className="at-note">{report.lead.reason}</p>
            </div>
          </div>
        </section>
      )}

      <section className="at-compare" aria-label={bestOfN ? 'Compare attempts' : 'Every attempt'}>
        <SectionHead label={bestOfN ? 'Compare attempts' : 'Every attempt'} count={detail.rows.length} />
        <div className="at-scroll">
          <table className="grid at-table">
            <thead>
              <tr>
                <th scope="col">Attempt</th><th scope="col">Gate</th><th scope="col" className="r">Files</th>
                <th scope="col" className="r">Cost</th><th scope="col" className="r">Duration</th><th scope="col">Oracle flags</th>
                {bestOfN && <th scope="col">Decision</th>}
              </tr>
            </thead>
            <tbody>
              {detail.rows.map((row, index) => {
                const kept = detail.keptAttemptId === row.id;
                const keepable = isTrialStatus(row.status) && row.gate !== 'running' && row.worktreeOnDisk;
                const tokens = tokenWords(row);
                return (
                  <tr key={row.id} data-attempt-id={row.id} className={kept ? 'at-kept' : undefined}>
                    <th scope="row">
                      <span className="at-attempt"><strong>#{index + 1}</strong> {label(row)}</span>
                      <Mark {...statusMark(row)} />
                      {row.error && row.status !== 'queued' && <small className="at-error">{row.error}</small>}
                      {row.status === 'queued' && row.liveStatus === 'awaiting' && (
                        <small className="at-gate-note">Its run is holding a call for you. Answer it under Headless runs.</small>
                      )}
                    </th>
                    <td>
                      {row.gate ? <Mark {...GATE_MARKS[row.gate]} /> : <span className="faint">waiting for its run</span>}
                      {row.gateNote && <small className="at-gate-note">{row.gateNote}</small>}
                    </td>
                    <td className="r">{row.filesChanged === null ? '—' : num(row.filesChanged)}</td>
                    <td className="r"><span className="at-figure"><span>{costWords(row)}</span>{tokens && <small>{tokens}</small>}</span></td>
                    <td className="r">{row.durationMs === null ? '—' : dur(row.durationMs)}</td>
                    <td className="at-oracle"><OracleCell row={row} /></td>
                    {bestOfN && (
                      <td>
                        {kept ? <Mark glyph="✓" word="kept" tone="ok" />
                          : <button className="btn btn-sm" disabled={!keepable || busy !== null} onClick={() => onKeep(row.id)}>Keep this attempt</button>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {bestOfN && !detail.keptAttemptId && <Hint>Keeping records your choice. It merges nothing and removes nothing.</Hint>}
      </section>

      <section className="at-cleanup" aria-label="Attempt worktrees">
        <SectionHead label="Worktrees" count={detail.cleanup.worktrees.length} />
        {detail.cleanup.allowed && !confirmCleanup && (
          <button className="btn" disabled={busy !== null} onClick={onAskCleanup}>
            {detail.keptAttemptId ? 'Remove the other attempts’ worktrees…' : 'Remove the attempts’ worktrees…'}
          </button>
        )}
        {!detail.cleanup.allowed && detail.cleanup.reason && <Hint>{detail.cleanup.reason}</Hint>}
        {confirmCleanup && (
          <ConfirmNote verb="Remove worktrees" busy={busy === 'cleanup'} onRun={onCleanup} onCancel={onCancelCleanup}
            what={<>Remove {plural(detail.cleanup.worktrees.length, 'worktree')}{detail.keptAttemptId ? ', keeping the attempt you kept' : ''}?
              <ul className="at-paths">{detail.cleanup.worktrees.map((w) => <li key={w.attemptId} className="mono">{w.path}</li>)}</ul>
              Each goes through git without force, so one holding uncommitted work is kept and reported. Branches are kept. Nothing is merged.</>} />
        )}
        {cleanupResult && (
          <ul className="at-results" aria-label="What the cleanup did">
            {cleanupResult.results.map((result) => (
              <li key={result.attemptId}><Mark {...OUTCOME_MARKS[result.outcome]} /> <span className="mono">{result.path}</span> <small>{result.detail}</small></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
