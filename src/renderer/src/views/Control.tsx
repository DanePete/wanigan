import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ControlEvent, DocketAutopilot, DocketDetail, DocketNode, DocketNodeKind, DocketNodeStatus, GoalResumeReceipt, GoalTraceEvent, McpTaskCancelReceipt, McpTaskRecord, ModelOutcome, Project, ProviderInfo, WorkDocket,
} from '@shared/types';
import { Chip, ConfirmNote, EmptyState, Explainer, Hint, Icon, Mark, Note, PageHead, Pill, Reading, SectionHead, ago, markOf, usd } from '../components/bits';
import type { MarkSpec } from '../components/bits';
import Interview from './Interview';
import { useViewMemory } from '../components/viewMemory';
import ReviewEvidence from '../components/ReviewEvidence';
import GoalCompanion from '../components/GoalCompanion';
import { goalLocation } from '@shared/goal-journey';

const errText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Whether unattended dispatch is on, and whether it last stopped itself.
 *
 * Three states rather than a boolean because `haltedReason` outlives the halt:
 * a goal that stopped at its cap and a goal that was never armed both read
 * `enabled: false`, and only one of them is asking the operator for a decision.
 * `halted` is the tone that carries colour, because that is the one that waits
 * on a person. `armed` carries the accent for a narrower reason than the
 * attention queue's rule against painting a live agent: what this marks is not
 * an agent that is running, it is a standing authorisation to spend with
 * nobody at the keyboard, and the whole point of the card is that the operator
 * can see at a glance that it is on.
 */
const AUTOPILOT_MARKS: Record<'armed' | 'halted' | 'off', MarkSpec> = {
  armed:  { glyph: '▸', word: 'armed',  tone: 'accent' },
  halted: { glyph: '■', word: 'halted', tone: 'warn' },
  off:    { glyph: '○', word: 'off',    tone: 'quiet' },
};

/**
 * How much of a goal's spend a provider actually vouched for.
 *
 * Keyed on DocketAutopilot's own union rather than inferred: an inferred table
 * widens `tone` to string and Mark's Tone parameter refuses it, and naming the
 * union makes a fifth spend status a compile error here instead of a row that
 * is quietly missing at runtime. The words never round an absence up to a
 * measurement — control.ts counts only reported cost against the cap, so
 * "nothing reported" is a statement about what Wanigan can see, not a claim
 * that nothing was spent.
 */
const SPEND_MARKS: Record<DocketAutopilot['spendStatus'], MarkSpec> = {
  reported:   { glyph: '✓', word: 'all reported',     tone: 'ok' },
  partial:    { glyph: '?', word: 'partly reported',  tone: 'warn' },
  unreported: { glyph: '?', word: 'nothing reported', tone: 'warn' },
  none:       { glyph: '○', word: 'no session yet',   tone: 'quiet' },
};

const SPEND_READING: Record<DocketAutopilot['spendStatus'], string> = {
  reported: 'Every session this goal has launched reported its cost, so the figure beside the cap is the whole of it.',
  partial: 'Some of this goal’s sessions reported no cost. The cap is enforced against the part that was reported, which makes it a weaker ceiling than it looks.',
  unreported: 'No session on this goal has reported a cost. Nothing has been counted against the cap — which is not the same as nothing having been spent.',
  none: 'No session has been launched for this goal yet, so there is nothing to count against the cap.',
};
const goalHash = (id: string) => goalLocation(id);
const goalFromHash = () => new URLSearchParams(window.location.hash.slice(1)).get('goal');
const taskFromHash = () => new URLSearchParams(window.location.hash.slice(1)).get('task');
async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const field = document.createElement('textarea');
  field.value = value; field.setAttribute('readonly', ''); field.style.position = 'fixed'; field.style.opacity = '0';
  document.body.append(field); field.select();
  const copied = document.execCommand('copy'); field.remove();
  if (!copied) throw new Error('Your system clipboard did not accept the goal ID.');
}

/**
 * What the main process actually did, said in words.
 *
 * The notice used to run the wire enum through replace('_', ' '), so a reviewer
 * asking for changes was told "Task marked request changes.", and someone who
 * had merely finished a plan or verify task was told a decision had been
 * recorded. completeNode writes different things depending on the kind: a
 * review stores a `decision` proof, and a reject also flips the goal itself to
 * 'rejected', while every other kind just closes one node. So the kind, not
 * only the decision, chooses the sentence.
 */
function decisionNotice(kind: DocketNodeKind, decision: 'approve' | 'request_changes' | 'reject'): string {
  if (kind !== 'review') {
    return decision === 'approve' ? 'Task marked complete.' : 'Task marked failed. Reopen it when the next pass is ready.';
  }
  if (decision === 'approve') return 'Decision recorded: approved.';
  if (decision === 'request_changes') return 'Changes requested. The review task is marked failed; reopen it when the revised work is ready for another pass.';
  return 'Rejected. The review task is marked failed and this goal is recorded as rejected.';
}

/**
 * What cancelling an MCP task record actually did, said in words.
 *
 * The button used to announce nothing at all, and silence reads as success:
 * the same nothing covered an id that named no record, a record that had
 * already closed, a record marked cancelled over work that had ended before
 * the click landed, and a live agent killed mid-edit. The renderer cannot tell
 * those apart on its own — `act` evaluates its message before the work runs,
 * and the status it would read is a snapshot from the last load, so a running
 * agent that exits in between turns any pre-written sentence into a guess.
 * cancelMcpTask reports what it changed; this only spells the report out.
 */
function cancelNotice(receipt: McpTaskCancelReceipt): string {
  if (receipt.outcome === 'not_found') {
    return 'No task record has that ID, so nothing was changed. Reload the goal to see the tasks it has now.';
  }
  if (receipt.outcome === 'already_closed') {
    return `That task record was already ${receipt.recordStatus}, so nothing was changed.`;
  }
  if (receipt.outcome === 'record_only') {
    return `MCP task record marked cancelled. The task itself had already ended (${receipt.nodeStatus}), so no session was stopped and no file claim was released.`;
  }
  // Three ways to have stopped no agent, and only one of them is "there was
  // never one". A stored 'running' with no live session is worth saying out
  // loud: it is the shape an operator otherwise reads as a failed cancel.
  const head = receipt.sessionStopped
    ? 'Task canceled and its agent session stopped.'
    : receipt.nodeStatus === 'pending'
      ? 'Task canceled before it was ever started, so there was no agent session to stop.'
      : 'Task canceled. Wanigan held no live session for it, so nothing was stopped: its agent had already exited, or it was launched before the last restart.';
  const claims = receipt.claimsReleased === 0
    ? 'It had no open file claim to release.'
    : `${receipt.claimsReleased} file claim${receipt.claimsReleased === 1 ? '' : 's'} released.`;
  return `${head} ${claims} The goal is marked blocked until you reopen the task.`;
}

/**
 * Dockets are intentionally not a second terminal surface. They make the
 * contract, evidence and human decision visible before the operator opens the
 * agent that does the work.
 */
export default function Control({ projects, providers, onOpenSession }: {
  projects: Project[]; providers: ProviderInfo[]; onOpenSession: (id: string) => void;
}) {
  const [dockets, setDockets] = useState<WorkDocket[]>([]);
  const [selected, setSelected] = useViewMemory<string | null>('selected', null);
  const [query, setQuery] = useViewMemory('query', '');
  const [scope, setScope] = useViewMemory('projectScope', '');
  const [taskSelection, setTaskSelection] = useViewMemory<Record<string, string>>('taskSelection', {});
  const [createOpen, setCreateOpen] = useViewMemory('creating', false);
  const createButton = useRef<HTMLButtonElement>(null);
  /**
   * Which status the goal list is filtered to. 'all' is the default and the
   * way back; a filter that cannot be cleared is a list that lies about size.
   *
   * It is view memory rather than local state because opening a goal's session
   * unmounts Control: narrow the list to Blocked, press a task's Start, come
   * back, and the list had silently widened to every goal again. The operator
   * reads that as goals having changed status while they were away.
   */
  const [statusFilter, setStatusFilter] = useViewMemory<string>('statusFilter', 'all');
  const [detail, setDetail] = useState<DocketDetail | null>(null);
  const [outcomes, setOutcomes] = useState<ModelOutcome[]>([]);
  const [events, setEvents] = useState<ControlEvent[]>([]);
  const [tasks, setTasks] = useState<McpTaskRecord[]>([]);
  const [receipts, setReceipts] = useState<GoalResumeReceipt[]>([]);
  const [traces, setTraces] = useState<GoalTraceEvent[]>([]);
  // Two failures, two states. One `error` served both, so a refused budget
  // ("Budget must be a number…") rendered the goals card as "Could not read
  // your goals" with a Try again that reloaded a list which had read fine.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? loadError;
  /**
   * Whether control:list has answered at all.
   *
   * Without it the goal list said "Nothing is in flight. Create a goal before
   * sending work to an agent." from the first frame — while the read was still
   * in flight, and again after it failed. On a slow or broken read that is the
   * app telling the operator their durable work contracts do not exist, and
   * inviting them to make the one thing that would duplicate a goal they
   * already have.
   */
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [inspectAccepted, setInspectAccepted] = useState<string | null>(null);
  const [actionBusy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const busy = actionBusy ?? (refreshing ? 'reading' : null);
  const actionLock = useRef(false);
  const alive = useRef(true);
  const [projectId, setProjectId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [notes, setNotes] = useViewMemory<Record<string, string>>('notes', {});
  const [claims, setClaims] = useViewMemory<Record<string, string>>('claims', {});
  const [eventSource, setEventSource] = useState('manual');
  const [eventKind, setEventKind] = useState('CI failure');
  const [eventSummary, setEventSummary] = useState('');
  /**
   * Which goal's arm-autopilot confirmation is open, if any.
   *
   * It holds an id rather than a boolean so that choosing a different goal
   * cancels the confirmation instead of leaving a live "spend money unattended"
   * prompt pointing at work the operator has already navigated away from.
   */
  const [armAsk, setArmAsk] = useState<string | null>(null);
  /**
   * Which MCP task record has its cancel confirmation open, if any.
   *
   * It holds the record rather than a boolean for the same reason armAsk holds
   * an id: choosing another goal reloads the list underneath it, and a live
   * "stop the agent" prompt pointing at work the operator has navigated away
   * from is a click that lands somewhere they are not looking. The prompt is
   * rendered only while that record is still one of the rows on screen.
   */
  const [confirmCancel, setConfirmCancel] = useState<McpTaskRecord | null>(null);
  // Per-goal spend-cap drafts, keyed like `notes` and `claims` so a half-typed
  // number does not follow the operator to the next goal they open.
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});

  const enabledProviders = useMemo(() => providers.filter((provider) => !!provider.path), [providers]);
  const projectOptions = projects;

  // `selected` is read through a ref rather than a dependency: as a dependency
  // every selection changed load's identity, the mount effect below fired it a
  // second time, and each click cost fourteen IPC calls instead of seven.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  // Monotonic, so a slow answer for goal A cannot land after the operator has
  // already clicked goal B and set the page back to A.
  const loadSeq = useRef(0);
  const load = useCallback(async (focus?: string | null) => {
    const seq = ++loadSeq.current;
    if (focus && focus !== selectedRef.current) {
      selectedRef.current = focus; setSelected(focus); setDetail(null);
      setTasks([]); setReceipts([]); setTraces([]); setArmAsk(null); setConfirmCancel(null);
    }
    setRefreshing(true); setLoadError(null);
    try {
      const [next, nextOutcomes, nextEvents] = await Promise.all([
        window.wanigan.control.list(), window.wanigan.control.outcomes(), window.wanigan.control.events('all'),
      ]);
      if (!alive.current || seq !== loadSeq.current) return;
      setDockets(next); setOutcomes(nextOutcomes); setEvents(nextEvents);
      const linked = goalFromHash();
      const preferred = focus ?? selectedRef.current ?? linked;
      const id = preferred && next.some((docket) => docket.id === preferred) ? preferred : next[0]?.id ?? null;
      if (id !== selectedRef.current) {
        selectedRef.current = id; setSelected(id); setDetail(null);
        setTasks([]); setReceipts([]); setTraces([]); setArmAsk(null); setConfirmCancel(null);
      }
      if (id && next.some((docket) => docket.id === id)) {
        const [full, mcp, nextReceipts, nextTraces] = await Promise.all([
          window.wanigan.control.get(id), window.wanigan.control.mcpTasks(id), window.wanigan.control.resumeReceipts(id), window.wanigan.control.traces(id, 5),
        ]);
        if (!alive.current || seq !== loadSeq.current) return;
        const requestedTask = goalFromHash() === id ? taskFromHash() : null;
        const taskId = full.nodes.some(node => node.id === requestedTask) ? requestedTask : null;
        if (taskId) setTaskSelection(previous => ({ ...previous, [id]: taskId }));
        const location = goalLocation(id, taskId ?? undefined);
        if (window.location.hash !== location) window.history.replaceState(null, '', location);
        setSelected(id); setDetail(full); setTasks(mcp); setReceipts(nextReceipts); setTraces(nextTraces);
      } else { setSelected(null); setDetail(null); setTasks([]); setReceipts([]); setTraces([]); }
      setLoadError(null);
    } catch (e) { if (alive.current && seq === loadSeq.current) setLoadError(errText(e)); }
    finally { if (alive.current && seq === loadSeq.current) { setReady(true); setRefreshing(false); } }
  }, []);

  useEffect(() => { alive.current = true; void load(goalFromHash()); return () => { alive.current = false; loadSeq.current++; }; }, [load]);
  // The board is driven by main: autopilot queues and launches tasks on a
  // 10-second sweep, and sessions exit on their own. Without these the page sat
  // frozen at the last click while tasks started, spent and finished behind it.
  useEffect(() => {
    let timer: number | null = null;
    const nudge = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void load(); }, 400);
    };
    const offQueue = window.wanigan.on.queueChanged(nudge);
    const offExit = window.wanigan.on.exit(nudge);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      offQueue(); offExit();
    };
  }, [load]);
  useEffect(() => {
    const onHash = () => { const id = goalFromHash(); if (id) void load(id); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [load]);
  useEffect(() => { if (!projectId && projectOptions[0]) setProjectId(projectOptions[0].id); }, [projectId, projectOptions]);
  useEffect(() => { if (!providerId && enabledProviders[0]) setProviderId(enabledProviders[0].id); }, [enabledProviders, providerId]);

  const act = async (key: string, work: () => Promise<void>, message?: string) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(key); setActionError(null); setNotice(null);
    const origin = selectedRef.current;
    try { await work(); if (alive.current && (key === 'create' || key.startsWith('triage-') || selectedRef.current === origin) && message) setNotice(message); }
    catch (e) { if (alive.current && selectedRef.current === origin) setActionError(errText(e)); }
    finally { actionLock.current = false; if (alive.current) setBusy(null); }
  };

  // A completed action may refresh its own goal, never navigate back from a new one.
  const reloadGoal = async (id: string | null) => {
    if (alive.current && selectedRef.current === id) await load(id);
  };

  const choose = async (id: string) => {
    if (actionLock.current) return;
    setActionError(null); setNotice(null); setArmAsk(null); setConfirmCancel(null);
    if (window.location.hash !== goalHash(id)) window.history.replaceState(null, '', goalHash(id));
    await load(id);
  };
  /**
   * The clipboard gets the goal's own id, never a URL.
   *
   * This used to copy `file:///…#goal=…` under a notice promising that opening
   * it in Wanigan came back to this goal. Nothing in the app registers a URL
   * scheme and there is no address bar to paste one into, so that address
   * resolved in a browser or nowhere at all — a promise the app had no way to
   * keep. The id is what actually names the goal: in its own records, and in
   * the goalId an agent passes to wanigan_get_goal. So the id is what is
   * copied, and the notice says only that.
   */
  const copyGoalId = (id: string) => act(`copy-id-${id}`, async () => {
    await copyText(id);
  }, 'Goal ID copied. It names this goal in Wanigan’s records — an identifier, not a link.');
  const start = (node: DocketNode) => act(`start-${node.id}`, async () => {
    const launched = await window.wanigan.control.start(node.id, { providerId, model: model.trim() || undefined });
    await reloadGoal(detail?.id ?? null);
    if (alive.current && selectedRef.current === detail?.id && launched.sessionId) onOpenSession(launched.sessionId);
  }, 'Isolated agent session launched from this task’s contract.');
  const checkpoint = (node: DocketNode) => act(`checkpoint-${node.id}`, async () => {
    await window.wanigan.control.checkpoint(node.id, notes[node.id] || 'Operator checkpoint.');
    setNotes((previous) => ({ ...previous, [node.id]: '' })); await reloadGoal(detail?.id ?? null);
  }, 'Checkpoint saved with repository commit, worktree, and exact conversation ID when available.');
  const addClaim = (node: DocketNode) => act(`claim-${node.id}`, async () => {
    await window.wanigan.control.claim(node.id, claims[node.id] || '');
    setClaims((previous) => ({ ...previous, [node.id]: '' })); await reloadGoal(detail?.id ?? null);
  }, 'Path claimed. Overlapping active work is now refused.');
  const proof = (node: DocketNode) => act(`proof-${node.id}`, async () => {
    await window.wanigan.control.runProof(node.id); await reloadGoal(detail?.id ?? null);
  }, 'Review gate recorded as evidence.');
  // A failed or canceled task blocks everything downstream of it. Without this
  // the docket is a dead end: the main process can reopen the node, but nothing
  // in the UI could ask it to.
  //
  // The notice used to promise that reopening unblocked the dependents. It does
  // not: retryNode writes the node back to 'pending', and mapNodes still reports
  // a dependent as 'blocked' while any prerequisite is short of 'completed'
  // (control.ts). What reopening removes is the failure, not the wait.
  const retry = (node: DocketNode) => act(`retry-${node.id}`, async () => {
    await window.wanigan.control.retry(node.id);
    await reloadGoal(detail?.id ?? null);
  }, 'Task reopened and set back to pending. Start it again when you are ready; tasks that wait on it stay blocked until it completes.');

  /**
   * Whether cancelling this record would stop a live agent — as far as the
   * last load could see.
   *
   * A snapshot is honest here and nowhere else in this flow: it chooses
   * whether to ask before acting, which is a statement of intent, not a report
   * of what happened. mapNodes presents a stored 'pending' as 'ready' or
   * 'blocked' (control.ts), so 'running' is the only presented status that
   * implies a session exists at all. What was actually stopped comes back in
   * the receipt, after the fact.
   */
  const cancelStopsAgent = (task: McpTaskRecord) =>
    detail?.nodes.find((node) => node.id === task.nodeId)?.status === 'running';
  const cancelTask = (task: McpTaskRecord) => act(`cancel-task-${task.id}`, async () => {
    const receipt = await window.wanigan.control.cancelMcpTask(task.id);
    await reloadGoal(detail?.id ?? null);
    // Set inside the closure, after the call, and deliberately not through
    // act's third argument: act clears the notice on the way in and only
    // overwrites it from a message it was handed before the work ran, which is
    // exactly the sentence this cannot be.
    if (alive.current && selectedRef.current === detail?.id) setNotice(cancelNotice(receipt));
  });

  /**
   * Arm unattended dispatch, with the provider and model chosen just above.
   *
   * control.setAutopilot had no caller anywhere in the renderer, so the sweep
   * timer, the node queue runner, the budget precondition and the halt that
   * writes its own reason were a complete lane that no goal could ever enter.
   * The provider and model are frozen by the main process at this moment, so
   * what the confirmation names is what will actually run.
   */
  const arm = (docket: DocketDetail) => act(`autopilot-${docket.id}`, async () => {
    await window.wanigan.control.setAutopilot(docket.id, { enabled: true, providerId, model: model.trim() || undefined });
    setArmAsk(null); await reloadGoal(docket.id);
  }, 'Autopilot armed. Ready tasks other than Review are dispatched without further approval until reported spend reaches the cap or a halt is recorded.');
  // Stopping is the safe direction, so it is not confirmed. It is also not a
  // kill switch: startQueuedNode re-reads the flag, so a queued task will not
  // launch, but a session already running is a live PTY that keeps running.
  const disarm = (docket: DocketDetail) => act(`autopilot-${docket.id}`, async () => {
    await window.wanigan.control.setAutopilot(docket.id, { enabled: false });
    setArmAsk(null); await reloadGoal(docket.id);
  }, 'Autopilot disarmed. Nothing new is dispatched; a session already running keeps running until it ends.');
  // A goal created without a budget could otherwise never arm at all: the cap
  // is a precondition in control.ts and the create card makes it optional.
  const saveBudget = (docket: DocketDetail) => act(`budget-${docket.id}`, async () => {
    await window.wanigan.control.setBudget(docket.id, Number(budgetDrafts[docket.id] ?? ''));
    setBudgetDrafts((previous) => ({ ...previous, [docket.id]: '' })); await reloadGoal(docket.id);
  }, 'Spend cap saved. Autopilot stops when reported spend reaches it.');

  const complete = (node: DocketNode, decision: 'approve' | 'request_changes' | 'reject' = 'approve') => act(`complete-${node.id}-${decision}`, async () => {
    await window.wanigan.control.complete(node.id, { detail: notes[node.id] || undefined, decision });
    setNotes((previous) => ({ ...previous, [node.id]: '' })); await reloadGoal(detail?.id ?? null);
  }, decisionNotice(node.kind, decision));
  const addEvent = () => act('event', async () => {
    await window.wanigan.control.addEvent({ projectId: projectId || null, source: eventSource, kind: eventKind, summary: eventSummary });
    setEventSummary(''); await reloadGoal(detail?.id ?? null);
  }, 'Event added to the local triage inbox. It cannot launch work on its own.');
  const triage = (event: ControlEvent) => act(`triage-${event.id}`, async () => {
    const created = await window.wanigan.control.triageEvent(event.id, {}); await load(created.id);
  }, 'Event turned into a reviewed goal; no agent was launched automatically.');

  const scopedDockets = dockets.filter(docket => !scope || docket.projectId === scope);
  const shownDockets = scopedDockets.filter(docket => (statusFilter === 'all' || docket.status === statusFilter)
    && `${docket.title} ${docket.projectName} ${docket.objective}`.toLowerCase().includes(query.trim().toLowerCase()));
  const activeNode = detail?.nodes.find(node => node.id === taskSelection[detail.id])
    ?? detail?.nodes.find(node => node.kind === 'review' && node.status === 'ready')
    ?? detail?.nodes.find(node => ['failed', 'canceled', 'running', 'ready'].includes(node.status))
    ?? detail?.nodes[0];
  const selectTask = (id: string, focus = false) => {
    if (!detail) return;
    setTaskSelection(previous => ({ ...previous, [detail.id]: id }));
    window.history.replaceState(null, '', goalLocation(detail.id, id));
    if (focus) requestAnimationFrame(() => document.getElementById('control-task-title')?.focus());
  };
  // Named once because the cancel confirmation has to answer the same question
  // the rows do: a prompt is only allowed to stand while the record it names is
  // still on screen.
  const shownTasks = tasks.slice(0, 5);
  if (createOpen) return <Interview projects={projects} projectId={scope || projectId || null} backLabel="Back to goals"
    onCancel={() => { setCreateOpen(false); requestAnimationFrame(() => createButton.current?.focus()); }}
    onDone={id => { setCreateOpen(false); void choose(id); setNotice('Goal created. Choose a task when you are ready to begin.'); }} />;

  return <div className="pane control-view">
    <PageHead compact title="Review" lead="The work. The proof. Your call."
      actions={<><button className="btn" type="button" disabled={busy !== null} onClick={() => void load()}>{refreshing ? 'Refreshing…' : 'Refresh'}</button><button className="btn btn-primary" type="button" disabled={actionBusy !== null} ref={createButton} onClick={() => setCreateOpen(true)}><Icon name="plus" />New goal</button></>} />
    {error && !createOpen && <Note tone="error" onDismiss={actionError ? () => setActionError(null) : undefined}>{error} {loadError && !actionError && <button className="btn btn-sm" disabled={refreshing} onClick={() => void load()}>Try again</button>}</Note>}
    {notice && <Note tone="ok">{notice}</Note>}

    <div className="control-workbench">


      <aside className="control-list" aria-label="Goals">
        <SectionHead label="Goals" count={ready ? dockets.length : undefined} />
        <input type="search" className="field" aria-label="Search goals" placeholder="Find a goal…" value={query} onChange={event => setQuery(event.target.value)} />
        <select className="field" aria-label="Filter goals by project" value={scope} onChange={event => setScope(event.target.value)}>
          <option value="">Every project</option>{projectOptions.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        {dockets.length > 0 && <div className="control-chips" role="group" aria-label="Filter goals by status">
          <Chip pressed={statusFilter === 'all'} count={scopedDockets.length} onToggle={() => setStatusFilter('all')}>All</Chip>
          {[...new Set([...scopedDockets.map(d => d.status), ...(statusFilter === 'all' ? [] : [statusFilter])])].map(status => <Chip key={status} pressed={statusFilter === status}
            count={scopedDockets.filter(d => d.status === status).length} onToggle={() => setStatusFilter(statusFilter === status ? 'all' : status)}>{markOf(status).word}</Chip>)}
        </div>}
        {!ready && <Reading what="your goals" />}
        {ready && loadError !== null && dockets.length === 0 && <EmptyState posture="could-not-read" title="Could not read your goals" cue={loadError} action={<button className="btn" onClick={() => void load()}>Try again</button>} />}
        {ready && loadError === null && dockets.length === 0 && <Hint>No goals yet. Add an objective and its acceptance checks to start tracking work here.</Hint>}
        {shownDockets.length === 0 && dockets.length > 0 && <EmptyState posture="nothing-yet" title="No matching goals" cue="Try another title, project, or state." action={<button className="btn" onClick={() => { setQuery(''); setScope(''); setStatusFilter('all'); }}>Clear filters</button>} />}
        <div className="control-goals">{shownDockets.map(docket => <button type="button" key={docket.id} data-goal-id={docket.id} className={`control-docket ${selected === docket.id ? 'selected' : ''}`}
          disabled={actionBusy !== null} aria-current={selected === docket.id ? 'true' : undefined} onClick={() => void choose(docket.id)}>
          <span className="control-goal-state"><Mark {...markOf(docket.status)} /><small>{ago(docket.updatedAt)}</small></span>
          <strong>{docket.title}</strong><small>{docket.projectName}</small>
          {docket.autopilot.enabled && <Mark {...AUTOPILOT_MARKS.armed} word="Autopilot armed" />}
        </button>)}</div>
      </aside>
      <div className="control-reading" aria-busy={refreshing}>
        {!detail && (refreshing ? <Reading what="the goal" /> : <EmptyState posture={loadError ? 'could-not-read' : 'nothing-yet'}
          title={loadError ? 'This goal could not be read' : 'Make room for your next decision.'}
          cue={loadError ?? 'Keep an objective, its tasks, and the proof of what changed together.'}
          action={loadError ? <button className="btn" onClick={() => void load()}>Try again</button> : <button className="btn" onClick={() => setCreateOpen(true)}>Create your first goal</button>} />)}
        {detail && <section className="control-detail" key={detail.id} id={`goal-${detail.id}`}>
          <div className="control-identity"><span>{detail.projectName}</span><Pill status={detail.status} /><span>{detail.risk} risk</span>
            <details className="control-goal-meta"><summary>Record details</summary><div>
              <span className="mono">{detail.baseCommit ? `base ${detail.baseCommit.slice(0, 10)}` : 'no base commit recorded'}</span>
              <span className="mono">id {detail.id}</span><button className="btn btn-sm" onClick={() => void copyGoalId(detail.id)} disabled={busy !== null}>Copy goal ID</button>
            </div></details>
          </div>
          <div className="control-overview"><div className="control-intent"><h2>{detail.title}</h2><p>{detail.objective}</p></div>
            <GoalCompanion key={detail.id} goal={detail} unavailable={!!loadError} busy={busy !== null} onTask={id => selectTask(id, true)} onSession={onOpenSession} />
          </div>
          <div className="control-facts" aria-label="Recorded goal progress">
            <div><strong>{detail.nodes.filter(node => node.status === 'completed').length}<span> / {detail.nodes.length}</span></strong><span>tasks complete</span></div>
            <div><strong>{detail.proofs.length}</strong><span>proof records</span></div>
            <div><strong>{detail.autopilot.spendStatus === 'none' || detail.autopilot.spendStatus === 'unreported' ? '—' : usd(detail.autopilot.spendUsd)}</strong><span>{detail.autopilot.spendStatus === 'partial' ? 'partly reported spend' : detail.autopilot.spendStatus === 'reported' ? 'reported spend' : SPEND_MARKS[detail.autopilot.spendStatus].word}</span></div>
            <div><Mark {...AUTOPILOT_MARKS[detail.autopilot.enabled ? 'armed' : detail.autopilot.haltedReason ? 'halted' : 'off']} /><span>autopilot</span></div>
          </div>
          <section className="control-journey" aria-label="Task journey"><SectionHead label="Task journey" count={detail.nodes.length} right={<span className="faint">Choose a task to review</span>} />
            <div className="control-steps" role="tablist" aria-label="Goal tasks" onKeyDown={event => {
              const at = detail.nodes.findIndex(node => node.id === activeNode?.id);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? detail.nodes.length - 1 : event.key === 'ArrowRight' ? (at + 1) % detail.nodes.length : event.key === 'ArrowLeft' ? (at + detail.nodes.length - 1) % detail.nodes.length : -1;
              if (next < 0) return;
              event.preventDefault(); selectTask(detail.nodes[next].id);
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}>{detail.nodes.map((node, index) => <button type="button" role="tab" key={node.id} id={`control-tab-${node.id}`} data-node-id={node.id}
              aria-selected={activeNode?.id === node.id} aria-controls="control-task-panel" tabIndex={activeNode?.id === node.id ? 0 : -1} onClick={() => selectTask(node.id)}>
              <span className="control-step-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span className="control-step-copy"><span>{node.kind}</span><strong>{node.title}</strong><Mark {...markOf(node.status)} word={node.queued ? 'queued' : markOf(node.status).word} /></span>
            </button>)}</div>
          </section>
          <div className="control-decision">
            <div className="control-task" id="control-task-panel" role="tabpanel" aria-labelledby={activeNode ? `control-tab-${activeNode.id}` : undefined}>
              {detail.status === 'accepted' && activeNode?.kind === 'review' && activeNode.status === 'completed' && inspectAccepted !== detail.id
                ? <div className="control-finish"><Mark {...markOf('accepted')} /><h3 id="control-task-title" tabIndex={-1}>Accepted, with the receipts.</h3>
                  <p>Your decision is saved. The proof and handoffs stay here whenever you need them.</p>
                  {activeNode.detail && <blockquote>{activeNode.detail}</blockquote>}
                  <div className="control-review-actions"><button className="btn btn-primary" disabled={busy !== null} onClick={() => setCreateOpen(true)}>Plan the next goal</button>
                    <button className="btn" onClick={() => setInspectAccepted(detail.id)}>Read review record</button></div>
                </div>
                : activeNode ? <NodeCard key={activeNode.id} node={activeNode} busy={busy ?? (loadError ? 'unavailable' : null)} note={notes[activeNode.id] ?? ''} claim={claims[activeNode.id] ?? ''}
                prereqs={activeNode.dependsOn.map(id => detail.nodes.find(other => other.id === id)).filter((other): other is DocketNode => !!other)}
                onPrerequisite={id => selectTask(id, true)} onSession={() => activeNode.sessionId && onOpenSession(activeNode.sessionId)}
                onNote={value => setNotes(previous => ({ ...previous, [activeNode.id]: value }))} onClaim={value => setClaims(previous => ({ ...previous, [activeNode.id]: value }))}
                onStart={() => start(activeNode)} onCheckpoint={() => checkpoint(activeNode)} onClaimAdd={() => addClaim(activeNode)} onProof={() => proof(activeNode)} onComplete={decision => complete(activeNode, decision)} onRetry={() => retry(activeNode)} />
                : <Hint>No tasks were recorded for this goal.</Hint>}
            </div>
            <ReviewEvidence key={detail.id} docket={detail} receipts={receipts} traces={traces} onTask={id => selectTask(id, true)}>
              <SectionHead label="Active file claims" count={detail.claims.filter(claim => !claim.releasedAt).length} />
              {detail.claims.filter(claim => !claim.releasedAt).length === 0 ? <Hint>No active paths claimed.</Hint> : detail.claims.filter(claim => !claim.releasedAt).map(claim => <div key={claim.id} className="control-claim"><code>{claim.path}</code><button className="btn btn-sm" disabled={busy !== null} onClick={() => void act(`release-${claim.id}`, async () => { await window.wanigan.control.releaseClaim(claim.id); await reloadGoal(detail.id); })}>Release</button></div>)}
            </ReviewEvidence>
          </div>
      <details className="control-execution" key={`execution-${detail.id}`}>
        <summary><span>Execution &amp; spending</span><Mark {...AUTOPILOT_MARKS[detail.autopilot.enabled ? 'armed' : detail.autopilot.haltedReason ? 'halted' : 'off']}
          word={detail.autopilot.enabled ? 'Autopilot armed' : detail.autopilot.haltedReason ? 'Autopilot halted' : 'Autopilot off'} />
          <span className="faint">{detail.autopilot.enabled
            ? providers.find((provider) => provider.id === detail.autopilot.providerId)?.label ?? detail.autopilot.providerId
            : enabledProviders.find((provider) => provider.id === providerId)?.label ?? 'No installed provider'}
            {detail.autopilot.enabled && detail.budgetUsd !== null ? ` · ${usd(detail.budgetUsd)} cap` : ''}</span>
        </summary>
      <div className="control-launch"><label><span className="label">Provider for next task</span><select className="field" value={providerId} onChange={(event) => setProviderId(event.target.value)}>{enabledProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label><label><span className="label">Model override</span><input className="field" value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider default" /></label></div>
      <AutopilotCard docket={detail} busy={busy ?? (loadError ? 'unavailable' : null)} confirming={armAsk === detail.id}
        armWith={enabledProviders.find((provider) => provider.id === providerId)?.label ?? null} armWithModel={model}
        armedWith={providers.find((provider) => provider.id === detail.autopilot.providerId)?.label ?? detail.autopilot.providerId}
        budgetDraft={budgetDrafts[detail.id] ?? ''}
        onBudgetDraft={(value) => setBudgetDrafts((previous) => ({ ...previous, [detail.id]: value }))}
        onAsk={() => setArmAsk(detail.id)} onCancelAsk={() => setArmAsk(null)}
        onArm={() => void arm(detail)} onDisarm={() => void disarm(detail)} onSetBudget={() => void saveBudget(detail)} />
      </details>

        </section>}
      </div>
    </div>
    <details className="control-support">
      <summary>Events &amp; model evidence<span className="faint">{events.filter((event) => event.status === 'new').length} new events</span></summary>
    <section className="control-grid control-lower"><article><SectionHead label="Local event inbox" /><h2>A signal worth following.</h2><p className="faint">Capture a CI failure, incident, or issue, then decide whether it needs a goal.</p><label><span className="label">Event project</span><select className="field" value={projectId} onChange={event => setProjectId(event.target.value)}>{projectOptions.length === 0 && <option value="">No project available</option>}{projectOptions.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><div className="control-inline"><label><span className="label">Event source</span><input className="field" value={eventSource} onChange={(event) => setEventSource(event.target.value)} /></label><label><span className="label">Event kind</span><input className="field" value={eventKind} onChange={(event) => setEventKind(event.target.value)} /></label></div><textarea className="field control-textarea" aria-label="Event summary" value={eventSummary} onChange={(event) => setEventSummary(event.target.value)} placeholder="What happened? Include the observable failure, not a solution guess." /><button className="btn" disabled={busy !== null || !eventSummary.trim()} onClick={() => void addEvent()}>Add event</button>{/* Dismiss existed in main and in the preload and was reachable from
    nothing, so an event added by mistake could only be cleared by creating
    a Goal nobody wanted. Dismissed rows are also filtered out rather than
    left to consume the six visible slots. */}
{events.filter((event) => event.status !== 'dismissed').slice(0, 6).map((event) => <div className="control-event" key={event.id}><Pill status={event.status} /><strong>{event.kind}</strong><p>{event.summary}</p>{event.status === 'new' && <><button className="btn" disabled={busy !== null} onClick={() => void triage(event)}>Create goal</button><button className="btn" disabled={busy !== null} onClick={() => void act(`dismiss-${event.id}`, async () => { await window.wanigan.control.dismissEvent(event.id); await reloadGoal(detail?.id ?? null); })}>Dismiss</button></>}</div>)}</article>
      <article><SectionHead label="Model evidence" /><h2>What the outcomes say.</h2><p className="faint">Ordered by acceptance rate over completed goal evidence. One sample is one sample: the count is beside every row, and a cost is shown only for the sessions whose CLI reported one.</p>{outcomes.length === 0 ? <p className="faint">No completed provider outcomes yet.</p> : <table className="control-table"><thead><tr><th>Model</th><th>Task</th><th>Accept</th><th>Tests</th><th>Cost</th></tr></thead><tbody>{outcomes.map((outcome) => <tr key={`${outcome.providerId}-${outcome.model}-${outcome.taskKind}`}><td>{outcome.providerId}<small>{outcome.model}</small></td><td>{outcome.taskKind}<small>{outcome.samples} sample{outcome.samples === 1 ? '' : 's'}</small></td><td>{outcome.acceptedRate === null ? '—' : `${Math.round(outcome.acceptedRate * 100)}%`}</td><td>{outcome.testPassRate === null ? '—' : `${Math.round(outcome.testPassRate * 100)}%`}</td><td title={outcome.reportedSamples === outcome.samples ? undefined : `${outcome.reportedSamples} of ${outcome.samples} session${outcome.samples === 1 ? '' : 's'} reported a cost. The rest ran on a plan or a harness that reports none, so they are not in this figure.`}>{outcome.reportedSamples === 0 ? <span className="faint">not reported</span> : <>{usd(outcome.totalCostUsd)}{outcome.reportedSamples < outcome.samples && <small>{outcome.reportedSamples} of {outcome.samples} reported</small>}</>}</td></tr>)}</tbody></table>}
        <SectionHead label="Agent task records" count={shownTasks.length} /><Hint>{detail ? `For ${detail.title}.` : 'Select a goal to read its task records.'}</Hint>{shownTasks.map((task) => <p key={task.id}><Pill status={task.status} /> {task.title} {['working', 'input_required'].includes(task.status) && <button className="btn btn-sm" disabled={busy !== null} title={cancelStopsAgent(task)
          ? 'Cancel this task, stop the agent session running it, and release any file claims it holds. The goal is marked blocked until you reopen the task.'
          : 'Cancel this task. If it has not ended, any file claims it holds are released and the goal is marked blocked until you reopen it; if it has, only the MCP task record is marked cancelled.'}
          onClick={() => { if (cancelStopsAgent(task)) { setConfirmCancel(task); return; } void cancelTask(task); }}>Cancel task</button>}</p>)}
        {/* Once, after the list — never inside a row. The row is a <p> and
            ConfirmNote is a <div>, which the browser silently reparents out of
            it, moving the prompt away from the button that opened it. This is
            the T2 arm only: a live agent is stopped mid-edit. The other arms
            disclose through the button title and report through the receipt,
            because bits.tsx records that T2 must stay rare. */}
        {confirmCancel && shownTasks.some((task) => task.id === confirmCancel.id) && <ConfirmNote tone="error" busy={busy !== null}
          what={<>Cancel <strong>{confirmCancel.title}</strong>? The agent session running it is stopped, any file claims it holds are released, and the goal is marked blocked until you reopen the task.</>}
          verb="Cancel task and stop the agent" onCancel={() => setConfirmCancel(null)}
          onRun={() => { const task = confirmCancel; setConfirmCancel(null); return cancelTask(task); }} />}
      </article></section>
    <Explainer id="control-guide" title="How review works" defaultHidden>
      <div className="control-guide-body">
      <div><p>A <strong>goal</strong> is work you delegate without losing the reason for it, the evidence, or the final decision.</p></div>
      <ol>
        <li><strong>Define the contract.</strong> Choose a project, write the objective, then add observable acceptance checks. These become the shared definition of done. The task graph is the standard four phases until you open it and draw something else — parallel implement tasks with disjoint claims, reviewed by one task at the end.</li>
        <li><strong>Work the graph, not a fixed list.</strong> Start any task that has no unfinished prerequisite. Each card names what it waits on and how those tasks stand, so a task held by a failed prerequisite is told apart from one whose prerequisite is still running. Claim paths such as <code>src/cart/total.ts</code> before parallel work touches them.</li>
        <li><strong>Capture proof and continuity.</strong> Save a checkpoint before a handoff or interruption. In <em>Verify</em>, run the project review gate; a passing command result is required before the task can complete.</li>
        <li><strong>Make the final call.</strong> The <em>Review</em> task can approve only after verification passed. Request changes or reject when the evidence does not meet the contract.</li>
      </ol>
      <div className="control-example"><span className="label">Example</span><p><strong>Title:</strong> “Prevent duplicate checkout charge”</p><p><strong>Objective:</strong> “Make checkout retries idempotent without changing successful order flow.”</p><p><strong>Acceptance:</strong> “A repeated payment callback is ignored; the existing checkout suite passes; the diff has a review decision.”</p><p className="faint">Start Plan with your preferred provider, claim the payment handler during Implement, run the configured review gate in Verify, then approve or request changes in Review.</p></div>
      </div>
    </Explainer>
    </details>
  </div>;
}

/**
 * Arm or disarm unattended dispatch for one goal.
 *
 * Everything under this card was already built and unreachable: the sweep
 * timer, the node queue runner, the budget precondition, the review task the
 * dispatcher refuses to touch, and the halt that writes its own reason into
 * the goal's evidence. No renderer surface called control.setAutopilot, so no
 * goal was ever armed, so none of it ever ran. This is the switch.
 *
 * It is the one action in Control behind a confirmation, and the sentence in
 * that confirmation is the point of the tier rather than decoration: this is
 * the control that lets an agent spend real money with nobody at the keyboard,
 * so the prompt names the cap, names the provider that was frozen, and says
 * outright that no further approval will be asked for.
 *
 * A goal with no cap cannot arm. control.ts is where that is enforced; the
 * card carries the same rule so the operator meets it as a ceiling to set
 * rather than as an error after pressing a button that looked available.
 */
function AutopilotCard({ docket, busy, confirming, armWith, armWithModel, armedWith, budgetDraft, onBudgetDraft, onAsk, onCancelAsk, onArm, onDisarm, onSetBudget }: {
  docket: DocketDetail; busy: string | null; confirming: boolean;
  /** The provider that would be frozen if the operator armed right now, from
   *  the launch row above, or null when no provider is enabled at all. */
  armWith: string | null; armWithModel: string;
  /** The provider already frozen on an armed goal. Falls back to the recorded
   *  id when that provider has since been disabled, because the id is still
   *  what is running and a blank is not. */
  armedWith: string | null;
  budgetDraft: string; onBudgetDraft: (value: string) => void;
  onAsk: () => void; onCancelAsk: () => void; onArm: () => void; onDisarm: () => void; onSetBudget: () => void;
}) {
  const auto = docket.autopilot;
  const cap = auto.budgetUsd;
  const finished = ['accepted', 'rejected'].includes(docket.status);
  const state = auto.enabled ? AUTOPILOT_MARKS.armed
    : auto.haltedReason !== null ? AUTOPILOT_MARKS.halted : AUTOPILOT_MARKS.off;
  const spend = SPEND_MARKS[auto.spendStatus];
  const model = armWithModel.trim();
  return <div className="control-autopilot">
    <SectionHead label="Unattended dispatch" right={<Mark glyph={state.glyph} word={state.word} tone={state.tone} />} />
    <p>{auto.enabled
      ? `Wanigan is starting this goal’s ready tasks on its own${armedWith ? ` with ${armedWith}` : ''}${auto.model ? ` · ${auto.model}` : ''}, without asking again. A Review task is never dispatched.`
      : 'Nothing is dispatched on its own. Every task below waits for you to start it.'}</p>
    <div className="control-autopilot-facts">
      <span className="mono">{cap === null ? 'no cap set' : `${usd(cap)} cap`}</span>
      <span className="mono">{usd(auto.spendUsd)} reported</span>
      <Mark glyph={spend.glyph} word={spend.word} tone={spend.tone} />
    </div>
    <Hint>{SPEND_READING[auto.spendStatus]}</Hint>
    {/* The halt outlives the flag on purpose, so an armed goal that stopped
        once still shows why. Role "none": this is recorded evidence the card
        renders on mount, not the result of something the operator just did. */}
    {auto.haltedReason !== null && <Note tone="warn" role="none">
      {auto.enabled ? 'Last automatic stop' : 'Autopilot stopped'}{auto.haltedAt !== null ? ` ${ago(auto.haltedAt)}` : ''}: {auto.haltedReason}
    </Note>}
    <div className="control-inline control-autopilot-cap">
      <label><span className="label">Spend cap · USD</span>
        <input className="field" inputMode="decimal" value={budgetDraft} placeholder={cap === null ? '20.00' : cap.toFixed(2)}
               onChange={(event) => onBudgetDraft(event.target.value)} /></label>
      <button className="btn" disabled={busy !== null || !budgetDraft.trim()} onClick={onSetBudget}>{cap === null ? 'Set cap' : 'Update cap'}</button>
    </div>
    {/* Every branch that cannot offer the button says why in visible text. A
        disabled Arm with no sentence beside it is the dead end this view has
        already been fixed for twice. */}
    {finished ? <Hint>This goal is finished, so autopilot has nothing left to dispatch.</Hint>
      : auto.enabled ? <div className="control-autopilot-act">
          <button className="btn" disabled={busy !== null} onClick={onDisarm}>Disarm autopilot</button>
          <Hint>Disarming stops new dispatch, including tasks already queued. A session that is already running keeps running until it ends.</Hint>
        </div>
      : cap === null ? <Hint>Autopilot needs a spend cap before it can arm. Wanigan will not start an unattended run with no ceiling.</Hint>
      : armWith === null ? <Hint>No provider is enabled, so unattended dispatch would have nothing to launch.</Hint>
      : confirming ? <ConfirmNote verb="Arm autopilot" busy={busy !== null} onRun={onArm} onCancel={onCancelAsk}
          what={<>Arming lets this goal spend money with nobody watching. Wanigan will start an agent session
            for every ready task except Review, one after another and without asking again, using <strong>{armWith}</strong>
            {model ? <> on <span className="mono">{model}</span></> : null}. It stops when reported spend reaches
            the {usd(cap)} cap, when the goal is accepted or rejected, or when it halts itself and records why.
            {auto.spendStatus === 'partial' || auto.spendStatus === 'unreported'
              ? ' Reported cost is all the cap can count, and this goal already has sessions that reported none.'
              : ''}</>} />
      : <div className="control-autopilot-act">
          <button className="btn" disabled={busy !== null} onClick={onAsk}>Arm autopilot</button>
          <Hint>Tasks would dispatch with {armWith}{model ? ` on ${model}` : ''}, frozen at the moment you arm. A Review task is never dispatched.</Hint>
        </div>}
  </div>;
}

/**
 * One task in the graph, with the prerequisites it waits on named on the card.
 *
 * The main process reports 'blocked' for two different situations — a
 * prerequisite that failed or was canceled, and one that simply has not
 * finished yet (control.ts, mapNodes) — and the operator's next move differs:
 * reopen the failed task, or wait for the unfinished one. On any graph wider
 * than a chain the status word alone cannot say which, so each prerequisite is
 * listed with its own status.
 */
function NodeCard({ node, busy, note, claim, prereqs, onPrerequisite, onSession, onNote, onClaim, onStart, onCheckpoint, onClaimAdd, onProof, onComplete, onRetry }: {
  node: DocketNode; busy: string | null; note: string; claim: string;
  prereqs: { id: string; title: string; status: DocketNodeStatus }[];
  onPrerequisite: (id: string) => void; onSession: () => void;
  onNote: (value: string) => void; onClaim: (value: string) => void; onStart: () => void; onCheckpoint: () => void;
  onClaimAdd: () => void; onProof: () => void; onComplete: (decision?: 'approve' | 'request_changes' | 'reject') => void;
  onRetry: () => void;
}) {
  const [noteOpen, setNoteOpen] = useState(!!note);
  const actionable = ['ready', 'running'].includes(node.status);
  const reopenable = ['failed', 'canceled'].includes(node.status);
  return <article className="control-node">
    <SectionHead label={node.kind === 'review' ? 'Your decision' : node.kind === 'verify' ? 'Verification' : 'Selected task'} right={<Pill status={node.status} />} />
    <h3 id="control-task-title" tabIndex={-1}>{node.title}</h3>
    <p className="control-instructions">{node.instructions}</p>
    {node.detail && <Note tone={reopenable ? 'warn' : 'info'} role="none">{node.detail}</Note>}
    {prereqs.length > 0 && <div className="control-prereqs"><SectionHead label="Prerequisites" />{prereqs.map(prereq => <button type="button" key={prereq.id} className="control-dependency" onClick={() => onPrerequisite(prereq.id)}><span>{prereq.title}</span><Mark {...markOf(prereq.status)} /><Icon name="chevron-right" /></button>)}</div>}
    {node.sessionId && <div className="control-review-actions"><button className="btn" onClick={onSession}>Open session<Icon name="external" /></button><button className="btn" onClick={onCheckpoint} disabled={busy !== null}>Save checkpoint</button></div>}
    <div className="control-node-actions">
      {node.status === 'ready' && node.kind !== 'review' && (node.queued
        ? <Mark glyph="◴" word="queued by autopilot" tone="quiet" title="Autopilot has claimed this task and will launch it on its next sweep." />
        : <button className="btn btn-primary" onClick={onStart} disabled={busy !== null}>Start isolated task</button>)}
      {reopenable && <><Hint>Reopen this task for another pass. Its dependents stay blocked until it completes.</Hint><button className="btn" onClick={onRetry} disabled={busy !== null} title="Reopen this task so it can be started again. Tasks waiting on it stay blocked until it completes.">Reopen task</button></>}
      {node.kind === 'verify' && actionable && <button className="btn" onClick={onProof} disabled={busy !== null}>Run review gate</button>}
      {(actionable || node.sessionId) && (node.kind === 'review' ? <details className="control-note" open={noteOpen} onToggle={event => setNoteOpen(event.currentTarget.open)}><summary>{note.trim() ? 'Decision note added' : 'Add a decision note'}</summary><label><span className="label">Decision note</span><textarea className="field control-textarea" aria-label="Evidence or handoff note" value={note} onChange={event => onNote(event.target.value)} placeholder="What supports your decision?" disabled={busy !== null} /></label></details> : <label><span className="label">Evidence or handoff note</span><textarea className="field control-textarea" aria-label="Evidence or handoff note" value={note} onChange={event => onNote(event.target.value)} placeholder="What should the next person know?" disabled={busy !== null} /></label>)}
      {node.kind === 'implement' && actionable && <div className="control-inline"><input className="field" aria-label="Path to claim" value={claim} onChange={event => onClaim(event.target.value)} placeholder="src/path.ts" /><button className="btn" onClick={onClaimAdd} disabled={busy !== null || !claim.trim()}>Claim</button></div>}
      {node.kind === 'review' && actionable ? <div className="control-review-actions"><button className="btn btn-primary" onClick={() => onComplete('approve')} disabled={busy !== null}>Approve</button><button className="btn" onClick={() => onComplete('request_changes')} disabled={busy !== null}>Request changes</button><button className="btn btn-danger" onClick={() => onComplete('reject')} disabled={busy !== null}>Reject</button></div> : actionable && <button className="btn" onClick={() => onComplete('approve')} disabled={busy !== null}>Mark complete</button>}
      {node.kind === 'review' && node.status === 'ready' && <button className="btn btn-sm" onClick={onStart} disabled={busy !== null || node.queued}>Start isolated task</button>}
      {node.status === 'blocked' && <Hint>This task waits for its prerequisites to complete.</Hint>}
      {node.status === 'completed' && <Hint>This task is complete. Its recorded evidence stays available alongside it.</Hint>}
      {node.status === 'pending' && <Hint>{node.deferUntil ? `Parked until ${new Date(node.deferUntil).toLocaleString()}.` : 'This task is pending.'}</Hint>}
    </div>
  </article>;
}
