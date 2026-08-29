import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ControlEvent, DocketDetail, DocketNode, DocketRisk, McpTaskRecord, ModelOutcome, Project, ProviderInfo, WorkDocket,
} from '@shared/types';
import { Note, ago, usd } from '../components/bits';

const errText = (error: unknown) => error instanceof Error ? error.message : String(error);
const risks: DocketRisk[] = ['low', 'elevated', 'high'];

/**
 * Dockets are intentionally not a second terminal surface. They make the
 * contract, evidence and human decision visible before the operator opens the
 * agent that does the work.
 */
export default function Control({ projects, providers, onOpenSession }: {
  projects: Project[]; providers: ProviderInfo[]; onOpenSession: (id: string) => void;
}) {
  const [dockets, setDockets] = useState<WorkDocket[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocketDetail | null>(null);
  const [outcomes, setOutcomes] = useState<ModelOutcome[]>([]);
  const [events, setEvents] = useState<ControlEvent[]>([]);
  const [tasks, setTasks] = useState<McpTaskRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [risk, setRisk] = useState<DocketRisk>('elevated');
  const [budget, setBudget] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [claims, setClaims] = useState<Record<string, string>>({});
  const [eventSource, setEventSource] = useState('manual');
  const [eventKind, setEventKind] = useState('CI failure');
  const [eventSummary, setEventSummary] = useState('');

  const enabledProviders = useMemo(() => providers.filter((provider) => !!provider.path), [providers]);

  const load = useCallback(async (focus?: string | null) => {
    try {
      const [next, nextOutcomes, nextEvents] = await Promise.all([
        window.wanigan.control.list(), window.wanigan.control.outcomes(), window.wanigan.control.events('all'),
      ]);
      setDockets(next); setOutcomes(nextOutcomes); setEvents(nextEvents);
      const id = focus ?? selected ?? next[0]?.id ?? null;
      if (id && next.some((docket) => docket.id === id)) {
        const [full, mcp] = await Promise.all([window.wanigan.control.get(id), window.wanigan.control.mcpTasks(id)]);
        setSelected(id); setDetail(full); setTasks(mcp);
      } else { setSelected(null); setDetail(null); setTasks([]); }
      setError(null);
    } catch (e) { setError(errText(e)); }
  }, [selected]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!projectId && projects[0]) setProjectId(projects[0].id); }, [projectId, projects]);
  useEffect(() => { if (!providerId && enabledProviders[0]) setProviderId(enabledProviders[0].id); }, [enabledProviders, providerId]);

  const act = async (key: string, work: () => Promise<void>, message?: string) => {
    setBusy(key); setError(null); setNotice(null);
    try { await work(); if (message) setNotice(message); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(null); }
  };

  const create = () => act('create', async () => {
    const created = await window.wanigan.control.create({ projectId, title, objective,
      acceptance: acceptance.split('\n').map((line) => line.trim()).filter(Boolean), risk,
      budgetUsd: budget.trim() ? Number(budget) : null });
    setTitle(''); setObjective(''); setAcceptance(''); setBudget(''); await load(created.id);
  }, 'Docket created. Start with the planning task; downstream work stays blocked until its prerequisites are complete.');

  const choose = (id: string) => act(`choose-${id}`, async () => { await load(id); });
  const start = (node: DocketNode) => act(`start-${node.id}`, async () => {
    const launched = await window.wanigan.control.start(node.id, { providerId, model: model.trim() || undefined });
    await load(detail?.id);
    if (launched.sessionId) onOpenSession(launched.sessionId);
  }, 'Isolated agent session launched from the docket contract.');
  const checkpoint = (node: DocketNode) => act(`checkpoint-${node.id}`, async () => {
    await window.wanigan.control.checkpoint(node.id, notes[node.id] || 'Operator checkpoint.');
    setNotes((previous) => ({ ...previous, [node.id]: '' })); await load(detail?.id);
  }, 'Checkpoint saved with repository commit, worktree, and exact conversation ID when available.');
  const addClaim = (node: DocketNode) => act(`claim-${node.id}`, async () => {
    await window.wanigan.control.claim(node.id, claims[node.id] || '');
    setClaims((previous) => ({ ...previous, [node.id]: '' })); await load(detail?.id);
  }, 'Path claimed. Overlapping active work is now refused.');
  const proof = (node: DocketNode) => act(`proof-${node.id}`, async () => {
    await window.wanigan.control.runProof(node.id); await load(detail?.id);
  }, 'Review gate recorded as evidence.');
  const complete = (node: DocketNode, decision: 'approve' | 'request_changes' | 'reject' = 'approve') => act(`complete-${node.id}-${decision}`, async () => {
    await window.wanigan.control.complete(node.id, { detail: notes[node.id] || undefined, decision });
    setNotes((previous) => ({ ...previous, [node.id]: '' })); await load(detail?.id);
  }, decision === 'approve' ? 'Task decision recorded.' : `Task marked ${decision.replace('_', ' ')}.`);
  const addEvent = () => act('event', async () => {
    await window.wanigan.control.addEvent({ projectId: projectId || null, source: eventSource, kind: eventKind, summary: eventSummary });
    setEventSummary(''); await load(detail?.id);
  }, 'Event added to the local triage inbox. It cannot launch work on its own.');
  const triage = (event: ControlEvent) => act(`triage-${event.id}`, async () => {
    const created = await window.wanigan.control.triageEvent(event.id, {}); await load(created.id);
  }, 'Event turned into a reviewed docket; no agent was launched automatically.');

  return <div className="control-view">
    <header className="control-head">
      <div><span className="label">Agent control plane</span><h1>Proof before merge</h1>
        <p>A docket is a durable work contract: task graph, worktree, claim, evidence, checkpoint, and human decision.</p></div>
      <div className="control-head-stats"><strong>{dockets.filter((docket) => ['executing', 'review'].includes(docket.status)).length}</strong><span>active dockets</span></div>
    </header>
    {error && <Note tone="error">{error}</Note>}
    {notice && <Note tone="ok">{notice}</Note>}

    <section className="control-grid">
      <article className="card control-create"><span className="label">New work contract</span><h2>Create a docket</h2>
        <label><span className="label">Project</span><select className="field" value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label><span className="label">Title</span><input className="field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Harden checkout retry" /></label>
        <label><span className="label">Objective</span><textarea className="field control-textarea" value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="What must change, and why?" /></label>
        <label><span className="label">Acceptance checks · one per line</span><textarea className="field control-textarea" value={acceptance} onChange={(event) => setAcceptance(event.target.value)} placeholder={'Targeted tests pass\nFailure mode is covered\nDiff is reviewed'} /></label>
        <div className="control-inline"><label><span className="label">Risk</span><select className="field" value={risk} onChange={(event) => setRisk(event.target.value as DocketRisk)}>{risks.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label><span className="label">Budget · USD</span><input className="field" inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="optional" /></label></div>
        <button className="btn btn-primary" disabled={busy !== null || !projectId || !title.trim() || !objective.trim() || !acceptance.trim()} onClick={() => void create()}>{busy === 'create' ? 'Creating…' : 'Create work graph'}</button>
      </article>

      <article className="card control-list"><div className="control-card-head"><div><span className="label">Durable work</span><h2>Dockets</h2></div><span className="faint">{dockets.length}</span></div>
        {dockets.length === 0 && <p className="faint">Nothing is in flight. Create a contract before sending work to an agent.</p>}
        {dockets.map((docket) => <button key={docket.id} className={`control-docket ${selected === docket.id ? 'selected' : ''}`} onClick={() => void choose(docket.id)}><span className={`control-status ${docket.status}`}>{docket.status}</span><strong>{docket.title}</strong><small>{docket.projectName} · {ago(docket.updatedAt)}</small></button>)}
      </article>
    </section>

    {detail && <section className="control-detail card"><div className="control-card-head"><div><span className="label">{detail.status} · {detail.risk} risk{detail.budgetUsd !== null ? ` · ${usd(detail.budgetUsd)} budget` : ''}</span><h2>{detail.title}</h2></div><span className="mono">base {detail.baseCommit?.slice(0, 10) ?? 'not a git repo'}</span></div>
      <p>{detail.objective}</p><ol className="control-acceptance">{detail.acceptance.map((check, index) => <li key={index}>{check}</li>)}</ol>
      <div className="control-launch"><label><span className="label">Provider for next task</span><select className="field" value={providerId} onChange={(event) => setProviderId(event.target.value)}>{enabledProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label><label><span className="label">Model override</span><input className="field" value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider default" /></label></div>
      <div className="control-nodes">{detail.nodes.map((node) => <NodeCard key={node.id} node={node} busy={busy} note={notes[node.id] ?? ''} claim={claims[node.id] ?? ''}
        onNote={(value) => setNotes((previous) => ({ ...previous, [node.id]: value }))} onClaim={(value) => setClaims((previous) => ({ ...previous, [node.id]: value }))}
        onStart={() => start(node)} onCheckpoint={() => checkpoint(node)} onClaimAdd={() => addClaim(node)} onProof={() => proof(node)} onComplete={(decision) => complete(node, decision)} />)}</div>
      <div className="control-evidence"><div><span className="label">Proof bundle</span><h3>{detail.proofs.length} record{detail.proofs.length === 1 ? '' : 's'}</h3>{detail.proofs.length === 0 ? <p className="faint">No evidence yet. A review gate result is required before verification can pass.</p> : detail.proofs.map((proof) => <p key={proof.id}><span className={`control-status ${proof.status}`}>{proof.status}</span> {proof.summary} <small>{ago(proof.createdAt)}</small></p>)}</div><div><span className="label">Continuity</span><h3>{detail.checkpoints.length} checkpoint{detail.checkpoints.length === 1 ? '' : 's'}</h3>{detail.checkpoints.length === 0 ? <p className="faint">Save a checkpoint before handoff or interruption. It records the exact provider conversation when one exists.</p> : detail.checkpoints.slice(0, 4).map((checkpoint) => <p key={checkpoint.id}>{checkpoint.note}<small>{checkpoint.conversationId ? ` · thread ${checkpoint.conversationId.slice(0, 12)}…` : ''} · {ago(checkpoint.createdAt)}</small></p>)}</div></div>
      <div className="control-claims"><span className="label">Active file claims</span>{detail.claims.filter((claim) => !claim.releasedAt).length === 0 ? <p className="faint">No paths claimed. Claims are optional but prevent overlapping parallel edits.</p> : detail.claims.filter((claim) => !claim.releasedAt).map((claim) => <span key={claim.id} className="control-claim">{claim.path} <button className="btn btn-small" onClick={() => void act(`release-${claim.id}`, async () => { await window.wanigan.control.releaseClaim(claim.id); await load(detail.id); })}>release</button></span>)}</div>
    </section>}

    <section className="control-grid control-lower"><article className="card"><span className="label">Local event inbox</span><h2>Triage, don’t auto-run</h2><p className="faint">Use this for CI, incident, or issue signals. Remote webhooks are intentionally not opened until their identity and replay controls are designed.</p><div className="control-inline"><input className="field" value={eventSource} onChange={(event) => setEventSource(event.target.value)} aria-label="Event source" /><input className="field" value={eventKind} onChange={(event) => setEventKind(event.target.value)} aria-label="Event kind" /></div><textarea className="field control-textarea" value={eventSummary} onChange={(event) => setEventSummary(event.target.value)} placeholder="What happened? Include the observable failure, not a solution guess." /><button className="btn" disabled={busy !== null || !eventSummary.trim()} onClick={() => void addEvent()}>Add event</button>{events.slice(0, 6).map((event) => <div className="control-event" key={event.id}><span className={`control-status ${event.status}`}>{event.status}</span><strong>{event.kind}</strong><p>{event.summary}</p>{event.status === 'new' && <button className="btn btn-small" onClick={() => void triage(event)}>Create docket</button>}</div>)}</article>
      <article className="card"><span className="label">Model evidence</span><h2>Outcome router</h2><p className="faint">This ranks only completed docket evidence; it does not invent a winner from token volume or a single run.</p>{outcomes.length === 0 ? <p className="faint">No completed provider outcomes yet.</p> : <table className="control-table"><thead><tr><th>Model</th><th>Task</th><th>Accept</th><th>Tests</th><th>Cost</th></tr></thead><tbody>{outcomes.map((outcome) => <tr key={`${outcome.providerId}-${outcome.model}-${outcome.taskKind}`}><td>{outcome.providerId}<small>{outcome.model}</small></td><td>{outcome.taskKind}<small>{outcome.samples} sample{outcome.samples === 1 ? '' : 's'}</small></td><td>{outcome.acceptedRate === null ? '—' : `${Math.round(outcome.acceptedRate * 100)}%`}</td><td>{outcome.testPassRate === null ? '—' : `${Math.round(outcome.testPassRate * 100)}%`}</td><td>{usd(outcome.totalCostUsd)}</td></tr>)}</tbody></table>}
        <span className="label">MCP task compatibility</span><p className="faint">Docket tasks have durable working/input-required/completed/cancelled state ready for the evolving MCP Tasks adapter.</p>{tasks.slice(0, 5).map((task) => <p key={task.id}><span className={`control-status ${task.status}`}>{task.status}</span> {task.title} {['working', 'input_required'].includes(task.status) && <button className="btn btn-small" onClick={() => void act(`cancel-task-${task.id}`, async () => { await window.wanigan.control.cancelMcpTask(task.id); await load(detail?.id); })}>cancel</button>}</p>)}</article></section>
  </div>;
}

function NodeCard({ node, busy, note, claim, onNote, onClaim, onStart, onCheckpoint, onClaimAdd, onProof, onComplete }: {
  node: DocketNode; busy: string | null; note: string; claim: string;
  onNote: (value: string) => void; onClaim: (value: string) => void; onStart: () => void; onCheckpoint: () => void;
  onClaimAdd: () => void; onProof: () => void; onComplete: (decision?: 'approve' | 'request_changes' | 'reject') => void;
}) {
  const actionable = ['ready', 'running'].includes(node.status);
  return <article className="control-node"><div><span className={`control-status ${node.status}`}>{node.status}</span><span className="label">{node.kind}</span><h3>{node.title}</h3><p>{node.instructions}</p>{node.sessionId && <button className="btn btn-small" onClick={onCheckpoint} disabled={busy !== null}>Checkpoint</button>}</div>
    <div className="control-node-actions">{node.status === 'ready' && <button className="btn btn-primary" onClick={onStart} disabled={busy !== null}>Start isolated task</button>}{node.kind === 'verify' && actionable && <button className="btn" onClick={onProof} disabled={busy !== null}>Run review gate</button>}<input className="field" value={note} onChange={(event) => onNote(event.target.value)} placeholder="Evidence or handoff note" disabled={!actionable} />{node.kind === 'implement' && actionable && <div className="control-inline"><input className="field" value={claim} onChange={(event) => onClaim(event.target.value)} placeholder="src/path.ts" /><button className="btn btn-small" onClick={onClaimAdd} disabled={busy !== null || !claim.trim()}>Claim</button></div>}{node.kind === 'review' && actionable ? <div className="control-review-actions"><button className="btn btn-primary" onClick={() => onComplete('approve')} disabled={busy !== null}>Approve</button><button className="btn" onClick={() => onComplete('request_changes')} disabled={busy !== null}>Request changes</button><button className="btn btn-danger" onClick={() => onComplete('reject')} disabled={busy !== null}>Reject</button></div> : actionable && <button className="btn" onClick={() => onComplete('approve')} disabled={busy !== null}>Mark complete</button>}</div>
  </article>;
}
