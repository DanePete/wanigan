import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocketNode, Project, ProviderInfo, RelayRead, WorkDocket } from '@shared/types';
import { EmptyState, Hint, Note, PageHead, Pill, Section, SectionHead, Stat, ago, dur, usd } from '../components/bits';
import { AGENT_KINDS, KIND_WORD, phasesOf, type Phase } from '../relay/facts';
import RelayComposer from '../relay/RelayComposer';
import RelayRig from '../relay/RelayRig';
import '../styles/relay.css';

type Props = {
  projects: Project[]; projectId: string | null; providers: ProviderInfo[];
  openSession: (id: string) => void; openGoal: (id: string, taskId?: string) => void;
};
const POLL_MS = 5_000;
const CLOCK_MS = 2_000;
const activityKey = (node: DocketNode) => `${node.id}:${node.sessionId ?? 'none'}`;

/** Project-scoped state never carries a selection or an unfinished request into another project. */
export default function Relay(props: Props) {
  return <RelayWorkspace key={props.projectId ?? 'no-project'} {...props} />;
}

function RelayWorkspace({ projects, projectId, providers, openSession, openGoal }: Props) {
  const [relays, setRelays] = useState<WorkDocket[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RelayRead | null>(null);
  const [listReady, setListReady] = useState(!projectId);
  const [readError, setReadError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [composerBusy, setComposerBusy] = useState(false);
  const [inspected, setInspected] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now);
  const [extras, setExtras] = useState<Record<string, number[]>>({});
  const readSequence = useRef(0);
  const listSequence = useRef(0);
  const selection = useRef<string | null>(null);
  const alive = useRef(true);
  const actionPending = useRef(false);
  const seenEvents = useRef(new Set<number>());
  const newButton = useRef<HTMLButtonElement>(null);
  const actionEl = useRef<HTMLElement>(null);
  const createdFocus = useRef(false);
  const read = snapshot?.docket.id === selected ? snapshot : null;
  const project = projects.find((row) => row.id === projectId);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const select = useCallback((id: string) => {
    selection.current = id;
    readSequence.current++;
    setSelected(id); setSnapshot(null); setExtras({}); seenEvents.current.clear();
    setInspected(null); setReadError(null); setActionError(null); setCreating(false);
  }, []);

  const loadList = useCallback(async () => {
    if (!projectId) return;
    const request = ++listSequence.current;
    try {
      const rows = await window.wanigan.relay.list(projectId, 50);
      if (!alive.current || request !== listSequence.current) return;
      setRelays(rows); setListError(null); setListReady(true);
      if (!selection.current && rows[0]) select(rows[0].id);
    } catch (cause) {
      if (!alive.current || request !== listSequence.current) return;
      setListReady(true); setListError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [projectId, select]);

  const loadRead = useCallback(async () => {
    const id = selected;
    if (!id) return;
    const request = ++readSequence.current;
    try {
      const next = await window.wanigan.relay.read(id);
      if (!alive.current || request !== readSequence.current || selection.current !== id) return;
      setSnapshot(next); setReadError(null);
      setExtras((current) => Object.fromEntries(next.docket.nodes.map((node) => [activityKey(node),
        (current[activityKey(node)] ?? []).filter((at) => !next.nodes.find((row) => row.nodeId === node.id)?.completions.includes(at))])));
      setRelays((rows) => rows.map((row) => row.id === id ? next.docket : row));
    } catch (cause) {
      if (!alive.current || request !== readSequence.current || selection.current !== id) return;
      setReadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [selected]);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { void loadRead(); }, [loadRead]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) { void loadRead(); setClock(Date.now()); } };
    const timer = setInterval(refresh, POLL_MS);
    const tick = setInterval(() => { if (!document.hidden) setClock(Date.now()); }, CLOCK_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); clearInterval(tick); document.removeEventListener('visibilitychange', refresh); };
  }, [loadRead]);
  useEffect(() => { const off = window.wanigan.on.sessionEvent((event) => {
    if (!alive.current || selection.current !== read?.docket.id || event.event !== 'PostToolUse' || seenEvents.current.has(event.id)) return;
    const node = read?.docket.nodes.find((row) => row.sessionId === event.sessionId);
    if (!node || read?.nodes.find((row) => row.nodeId === node.id)?.completions.includes(event.at)) return;
    seenEvents.current.add(event.id);
    if (seenEvents.current.size > 256) seenEvents.current.delete(seenEvents.current.values().next().value!);
    setExtras((current) => ({ ...current, [activityKey(node)]: [...(current[activityKey(node)] ?? []), event.at].slice(-64) }));
  }); return () => { off(); }; }, [read]);

  const phases = useMemo(() => read ? phasesOf(read, Object.fromEntries(read.docket.nodes.map((node) => [node.id, extras[activityKey(node)] ?? []])), clock) : [], [read, extras, clock]);
  const current = phases.find((phase) => phase.node.status !== 'completed') ?? phases.at(-1) ?? null;
  const detail = phases.find((phase) => phase.node.id === inspected) ?? current;
  const completed = phases.filter((phase) => phase.node.status === 'completed').length;
  const done = phases.length > 0 && completed === phases.length;
  const composerOpen = creating || (listReady && !selected && !listError);
  const forecast = read?.forecast;
  useEffect(() => {
    if (!createdFocus.current || !read || composerOpen) return;
    createdFocus.current = false;
    actionEl.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [read, composerOpen]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    if (actionPending.current || readError) return;
    actionPending.current = true; setBusy(key); setActionError(null);
    const id = selected;
    try { await run(); if (alive.current && selection.current === id) await loadRead(); }
    catch (cause) {
      if (alive.current && selection.current === id) setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally { actionPending.current = false; if (alive.current) setBusy(null); }
  };
  const start = (node: DocketNode) => act('start', () => window.wanigan.control.start(node.id, {
    providerId: node.providerId ?? providers[0]?.id ?? '', model: node.model ?? undefined, effort: node.effort ?? undefined,
  }));
  const finish = (node: DocketNode, decision?: 'approve' | 'request_changes' | 'reject') =>
    act('complete', () => window.wanigan.control.complete(node.id, { decision }));
  const verify = (node: DocketNode) => act('verify', async () => {
    const proof = await window.wanigan.control.runProof(node.id);
    if (proof.status === 'passed') await window.wanigan.control.complete(node.id);
    else throw new Error(proof.summary || 'Verification did not pass. Review the recorded evidence before trying again.');
  });
  const chooseStage = (id: string) => { setInspected(id); };
  const onCreated = (next: RelayRead) => {
    listSequence.current++; // A list fetched before creation cannot erase the new relay.
    createdFocus.current = true;
    select(next.docket.id); setSnapshot(next); setListReady(true);
    setRelays((rows) => [next.docket, ...rows.filter((row) => row.id !== next.docket.id)]);
  };
  const currentSummary = done ? 'All stages completed' : current ? `${KIND_WORD[current.node.kind]} · ${current.state.word}` : 'Reading stages';

  return <main className="pane rl-view">
    <PageHead eyebrow={project?.name ?? 'No project'} title="Relay"
      lead="One outcome. A clear handoff at every stage."
      actions={selected && !composerOpen ? <button ref={newButton} className="btn btn-primary" disabled={busy !== null}
        onClick={() => setCreating(true)}>New relay</button> : undefined} />
    {listError && <Note tone="error" action={{ label: 'Try again', run: loadList }}>{listError}</Note>}
    {relays.length > 0 && <div className="rl-toolbar">
      <label className="rl-picker"><span className="label">Relay</span>
        <select className="field" aria-label="Choose a relay" value={selected ?? ''} disabled={busy !== null || composerBusy}
          onChange={(event) => select(event.target.value)}>
          {relays.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
        </select>
      </label>
      <span className="rl-sync">{relays.length === 50 ? 'Latest 50 relays' : `${relays.length} relay${relays.length === 1 ? '' : 's'}`} in this project</span>
    </div>}
    {!listReady && <Note>Reading this project’s relays…</Note>}
    <RelayComposer projectId={projectId} providers={providers} active={composerOpen} onCreated={onCreated} onPendingChange={setComposerBusy}
      onCancel={selected ? () => { setCreating(false); requestAnimationFrame(() => newButton.current?.focus()); } : undefined} />
    {!composerOpen && selected && <>
      {readError && <Note tone="error" action={{ label: 'Retry refresh', run: loadRead }}>
        {read ? 'Refresh failed. Showing the last recorded state. Refresh before changing a stage; sessions and evidence remain available. ' : ''}{readError}
      </Note>}
      {actionError && <Note tone="error" onDismiss={() => setActionError(null)}>{actionError}</Note>}
      {!read && !readError && <Note>Reading relay stages…</Note>}
      {read && <>
        <header className="rl-summary">
          <div><h2>{read.docket.title}</h2><p className="dim">{read.docket.objective}</p></div>
          <div className="rl-summary-state"><Pill status={current?.state.word ?? 'pending'}
            tone={current?.state.value === 'failed' ? 'bad' : done ? 'ok' : current?.node.status === 'running' ? 'accent' : 'quiet'} />
            <span className="faint">{completed} of {phases.length} stages complete</span></div>
        </header>
        <div className="rl-workspace">
          <section className="rl-journey" aria-label="Relay stages">
            <SectionHead label="Stage by stage" count={phases.length} />
            <RelayRig key={read.docket.id} relayId={read.docket.id} phases={phases} selectedNodeId={detail?.node.id ?? null} onSelect={chooseStage} />
          </section>
          <div className="rl-work">
            <section ref={actionEl} className="rl-next" aria-label="Current relay action" aria-busy={busy !== null}>
              <SectionHead label={done ? 'Relay complete' : 'Up next'} right={<span className="faint" role="status">{currentSummary}</span>} />
              <div className="rl-next-content" key={`${read.docket.id}:${current?.node.id}:${current?.node.status}`}>
                {current && <RelayAction phase={current} read={read} done={done} busy={busy} unavailable={!!readError}
                  start={start} finish={finish} verify={verify}
                  estimate={() => act('estimate', () => window.wanigan.relay.estimate(read.docket.id))}
                  retry={() => act('retry', () => window.wanigan.control.retry(current.node.id))}
                  openSession={openSession} openGoal={() => openGoal(read.docket.id, current.node.id)} />}
                {!current && <EmptyState posture="nothing-yet" title="No stages in this relay" cue="Open this relay in Goals to inspect its task graph."
                  action={<button className="btn" onClick={() => openGoal(read.docket.id)}>Open in Goals</button>} />}
              </div>
            </section>
            {detail && <div className="rl-detail" aria-label={`${KIND_WORD[detail.node.kind]} stage details`}>
              <SectionHead label={`${KIND_WORD[detail.node.kind]} details`}
                right={detail.node.id !== current?.node.id ? <button className="btn btn-sm" onClick={() => setInspected(null)}>Back to current stage</button> : undefined} />
              <div className="rl-detail-content" key={detail.node.id}>
                <p className="rl-stage-instructions">{detail.node.instructions || detail.node.title}</p>
                <dl className="rl-facts">
                  <div><dt>Status</dt><dd>{detail.state.word}</dd></div>
                  <div><dt>{AGENT_KINDS.includes(detail.node.kind) ? 'Model' : 'Runs on'}</dt><dd>{detail.routeText}</dd></div>
                  {AGENT_KINDS.includes(detail.node.kind) && <div><dt>Recorded activity</dt><dd>{detail.completed} tool calls{detail.completions.length > 0 ? ` · latest ${ago(Math.max(...detail.completions))}` : ''}</dd></div>}
                </dl>
                {detail.route.reason && <p className="rl-route-reason">{detail.route.reason}</p>}
                {detail.node.detail && <Note role="none">{detail.node.detail}</Note>}
                <div className="rl-actions">
                  {detail.node.sessionId && <button className="btn btn-sm" onClick={() => openSession(detail.node.sessionId!)}>Open {KIND_WORD[detail.node.kind].toLowerCase()} session</button>}
                  <button className="btn btn-sm" onClick={() => openGoal(read.docket.id, detail.node.id)}>Inspect in Goals</button>
                </div>
                <details className="rl-evidence">
                  <summary>Recorded evidence ({read.docket.proofs.filter((proof) => proof.nodeId === detail.node.id).length})</summary>
                  {read.docket.proofs.filter((proof) => proof.nodeId === detail.node.id).length === 0
                    ? <p className="faint">No evidence recorded for this stage yet.</p>
                    : <ol>{read.docket.proofs.filter((proof) => proof.nodeId === detail.node.id).slice().sort((a, b) => b.createdAt - a.createdAt).map((proof) =>
                      <li key={proof.id}><Pill status={proof.status} /><p>{proof.summary}</p><span className="faint">{ago(proof.createdAt)}</span></li>)}</ol>}
                </details>
              </div>
            </div>}
            <Section title="Forecast" hint="An estimate from comparable phases recorded in this project.">
              {forecast && forecast.n > 0 ? <>
                <div className="stat-grid">
                  <Stat label="Estimated time" value={forecast.totalMs === null ? 'Unknown' : dur(forecast.totalMs)} sub={`${forecast.n} recorded phases`} />
                  <Stat label="Estimated cost" value={forecast.totalUsd === null ? 'Unpriced' : usd(forecast.totalUsd)} sub={`${forecast.perPhase.filter((phase) => phase.medianUsd !== null).length} of ${forecast.phases} phase costs known`} />
                </div>
                <details className="rl-evidence"><summary>Compare phase estimates</summary>
                  <dl className="rl-forecast-phases">{forecast.perPhase.map((phase) => <div key={phase.nodeId}>
                    <dt>{KIND_WORD[phase.kind]}</dt><dd>{phase.medianMs === null ? 'Unknown time' : dur(phase.medianMs)} / {phase.medianUsd === null ? 'unpriced' : usd(phase.medianUsd)}<span className="faint">{phase.n} comparable phases</span></dd>
                  </div>)}</dl>
                </details>
              </> : <Hint>{phases.some((phase) => phase.node.kind === 'estimate')
                ? 'The forecast appears after planning. Where there is too little comparable history, time and cost stay unknown.'
                : 'This relay skips planning and estimating. No forecast was recorded.'}</Hint>}
            </Section>
          </div>
        </div>
      </>}
    </>}
  </main>;
}

function RelayAction({ phase, read, done, busy, unavailable, start, finish, verify, estimate, retry, openSession, openGoal }: {
  phase: Phase; read: RelayRead; done: boolean; busy: string | null; unavailable: boolean;
  start: (node: DocketNode) => Promise<void>; finish: (node: DocketNode, decision?: 'approve' | 'request_changes' | 'reject') => Promise<void>;
  verify: (node: DocketNode) => Promise<void>; estimate: () => Promise<void>; retry: () => Promise<void>;
  openSession: (id: string) => void; openGoal: () => void;
}) {
  const { node } = phase;
  const working = busy !== null;
  const disabled = working || unavailable;
  if (read.docket.status === 'rejected') return <><h3>The work was rejected.</h3><p>The review decision is recorded. Inspect its evidence in Goals before deciding what to do next.</p><button className="btn" onClick={openGoal}>Review decision</button></>;
  if (node.kind === 'review' && node.status === 'failed' && phase.decision === 'request_changes') return <><h3>Changes were requested.</h3><p>The review is waiting for an implementation follow-up. Inspect the hand-back evidence before reopening the work.</p><button className="btn btn-primary" onClick={openGoal}>Review hand-back in Goals</button></>;
  if (done) return <><h3>The relay has reached its final decision.</h3><p>Review the recorded evidence and changes in Goals.</p><button className="btn" onClick={openGoal}>Review outcome</button></>;
  if (node.queued) return <><h3>{KIND_WORD[node.kind]} is queued.</h3><p>Waiting for its turn to launch. Its recorded state will update here.</p><button className="btn" onClick={openGoal}>View queue in Goals</button></>;
  if (node.gateRunningSince !== null) return <><h3>Verification is running.</h3><p>The project’s checks are running. Results will appear with the stage evidence.</p></>;
  if (node.status === 'failed' || node.status === 'canceled') return <><h3>{KIND_WORD[node.kind]} needs attention.</h3><p>{node.detail || 'Inspect the evidence, then reopen this stage when you are ready to retry.'}</p>
    <div className="rl-actions"><button className="btn btn-primary" disabled={disabled} onClick={() => void retry()}>{working ? 'Reopening…' : 'Reopen stage'}</button><button className="btn" onClick={openGoal}>Inspect in Goals</button></div></>;
  if (node.status === 'pending' || node.status === 'blocked') return <><h3>Waiting on an earlier stage.</h3><p>{node.deferUntil ? `Deferred until ${new Date(node.deferUntil).toLocaleString()}.` : 'This stage becomes available when its dependencies are complete.'}</p><button className="btn" onClick={openGoal}>Inspect dependencies</button></>;
  if (node.kind === 'estimate') return <><h3>Price the work before building.</h3><p>Use this project’s recorded history to estimate time and cost. This step is local and starts no agent.</p><button className="btn btn-primary" disabled={disabled} onClick={() => void estimate()}>{working ? 'Calculating…' : 'Run forecast'}</button></>;
  if (node.kind === 'verify') return <><h3>Check the implementation.</h3><p>Run the project’s review commands against the implementation. A current passing result completes verification.</p>
    {read.docket.reviewCommands === 0 && <Hint>No review commands are configured. Set up the review gate in Goals first.</Hint>}
    <div className="rl-actions"><button className="btn btn-primary" disabled={disabled || read.docket.reviewCommands === 0} onClick={() => void verify(node)}>{working ? 'Running verification…' : 'Run verification'}</button><button className="btn" onClick={openGoal}>Open review gate</button></div></>;
  if (node.status === 'ready') {
    const verb = node.kind === 'plan' ? 'Start planning' : node.kind === 'implement' ? 'Start implementation' : 'Start review';
    return <><h3>{node.kind === 'plan' ? 'Turn the outcome into a plan.' : node.kind === 'implement' ? 'Ready when you are.' : 'Give the work an independent review.'}</h3>
      <p>{node.kind === 'implement' ? 'Review the forecast below, then start building.' : 'Start this stage in a real agent session.'} It will run on {phase.routeText}.</p>
      {node.kind === 'implement' && <Hint>{read.forecast?.totalUsd === null || !read.forecast ? 'Cost is unpriced. Starting this stage may incur provider charges.' : `Estimated cost: ${usd(read.forecast.totalUsd)}. Actual usage may differ.`}</Hint>}
      <button className="btn btn-primary" disabled={disabled} onClick={() => void start(node)}>{working ? 'Starting…' : verb}</button></>;
  }
  return <><h3>{KIND_WORD[node.kind]} is running.</h3><p>{phase.state.word === 'quiet' ? 'No recent tool completions have been recorded. Open the session to see what the agent needs.' : 'Open the session to follow the work or respond to the agent.'}</p>
    <div className="rl-actions">{node.sessionId && <button className="btn btn-primary" onClick={() => openSession(node.sessionId!)}>Open live session</button>}
      {node.kind !== 'review' && <button className="btn" disabled={disabled} onClick={() => void finish(node)}>{working ? 'Recording…' : `Complete ${node.kind === 'plan' ? 'planning' : 'implementation'}`}</button>}
    </div>
    {node.kind === 'review' ? <div className="rl-decision"><p>After inspecting the work, record your decision.</p><div className="rl-actions">
      <button className="btn btn-primary" disabled={disabled} onClick={() => void finish(node, 'approve')}>Approve</button>
      <button className="btn" disabled={disabled} onClick={() => void finish(node, 'request_changes')}>Request changes</button>
      <button className="btn btn-danger" disabled={disabled} onClick={() => void finish(node, 'reject')}>Reject</button>
    </div><Hint>{read.nodes.find((row) => row.nodeId === read.docket.nodes.find((row) => row.kind === 'implement')?.id)?.handbacks ?? 0} of {read.handbackLimit} automatic hand-backs used. Requesting changes may launch another implementation turn.</Hint></div>
      : <Hint>Complete this stage only after reviewing the agent’s work. Required checks are validated before it advances.</Hint>}
  </>;
}
