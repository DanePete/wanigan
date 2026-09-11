import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardCard, DocketNodeStatus, Project, ProviderInfo } from '@shared/types';
import { Chip, EmptyState, Explainer, Icon, Mark, Note, PageHead, Pill, Reading, SectionHead, ago, markOf } from '../components/bits';
import { useDialog } from '../components/useDialog';
import { useViewMemory } from '../components/viewMemory';
import Interview from './Interview';

// The board is a second reading of the goal graph, never a second task store.
// Columns follow recorded state. Starting, reopening and parking use Control's
// existing commands; choosing a card or a filter performs no operation.
type ColumnId = 'ready' | 'running' | 'waiting' | 'blocked' | 'parked' | 'done';
type Column = { id: ColumnId; label: string; meaning: string };
const COLUMNS: readonly Column[] = [
  { id: 'ready', label: 'Ready', meaning: 'Prerequisites complete' },
  { id: 'running', label: 'In progress', meaning: 'Agent work underway' },
  { id: 'waiting', label: 'Waiting', meaning: 'Dependencies unfinished' },
  { id: 'blocked', label: 'Blocked', meaning: 'A failure needs attention' },
  { id: 'parked', label: 'Parked', meaning: 'Scheduled to return' },
  { id: 'done', label: 'Closed', meaning: 'Completed or canceled' },
];
const STATUS_COLUMN: Record<DocketNodeStatus, ColumnId> = {
  ready: 'ready', running: 'running', pending: 'waiting', blocked: 'blocked',
  failed: 'blocked', completed: 'done', canceled: 'done',
};
const PARK_FOR = [
  { label: 'Tomorrow', ms: 24 * 60 * 60_000 },
  { label: 'Next week', ms: 7 * 24 * 60 * 60_000 },
  { label: 'Next month', ms: 30 * 24 * 60 * 60_000 },
  { label: 'Next quarter', ms: 90 * 24 * 60 * 60_000 },
];
const RISK_WORD: Record<string, string> = { low: 'Low risk', elevated: 'Elevated risk', high: 'High risk' };
const KIND_WORD = { plan: 'Plan', implement: 'Implement', verify: 'Verify', review: 'Review' };
type BoardSnapshot = { scope: string | null; rows: BoardCard[]; at: number };
type Selection = { id: string; title: string; scope: string | null };
type ActionNote = { nodeId: string; title: string; text: string; tone: 'ok' | 'error' };

function columnOf(card: BoardCard, now = Date.now()): ColumnId {
  return card.node.deferUntil !== null && card.node.deferUntil > now
    && card.node.status !== 'running' && card.node.status !== 'completed'
    ? 'parked' : STATUS_COLUMN[card.node.status];
}
function when(at: number): string {
  const days = Math.round((at - Date.now()) / 86_400_000);
  if (days <= 0) return 'Due now';
  if (days === 1) return 'Back tomorrow';
  if (days < 14) return `Back in ${days} days`;
  if (days < 60) return `Back in ${Math.round(days / 7)} weeks`;
  return `Back ${new Date(at).toLocaleDateString()}`;
}

export default function Board({ projects, providers, projectId, selectedProjectId: scope, onPickProject, onOpenGoal, onOpenSession }: {
  projects: Project[]; providers: ProviderInfo[]; projectId: string | null;
  selectedProjectId: string | null; onPickProject: (id: string | null) => void;
  onOpenGoal: (docketId: string) => void; onOpenSession: (sessionId: string) => void;
}) {
  const [planning, setPlanning] = useViewMemory('planning', false);
  const launchable = useMemo(() => providers.filter(provider => !!provider.path), [providers]);
  const [provider, setProvider] = useViewMemory('provider', '');
  const [query, setQuery] = useViewMemory('query', '');
  const [filter, setFilter] = useViewMemory<ColumnId | 'all'>('column', 'all');
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [readError, setReadError] = useState<{ scope: string | null; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<ActionNote | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [arrivals, setArrivals] = useState<Set<string>>(new Set());
  const previous = useRef<BoardSnapshot | null>(null);
  const operation = useRef<string | null>(null);
  const read = useRef(0);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const cards = snapshot?.scope === scope ? snapshot.rows : null;
  const error = readError?.scope === scope ? readError.text : null;
  const selected = selection?.scope === scope ? cards?.find(card => card.node.id === selection.id) ?? null : null;
  const providerAvailable = launchable.some(row => row.id === provider);

  useEffect(() => {
    if (launchable.length && !launchable.some(row => row.id === provider)) setProvider(launchable[0].id);
  }, [launchable, provider, setProvider]);

  const load = useCallback(async () => {
    // An operation can finish after the operator changes projects. Its old
    // closure must not invalidate the new project's read when it refreshes.
    if (currentScope.current !== scope) return;
    const mine = ++read.current;
    try {
      const rows = await window.wanigan.control.board(scope, 500);
      if (mine !== read.current || currentScope.current !== scope) return;
      const at = Date.now(), last = previous.current;
      const oldColumns = new Map(last?.scope === scope ? last.rows.map(card => [card.node.id, columnOf(card, last.at)]) : []);
      // Only a task arriving in a different observed column gets motion. A
      // poll, filter change or initial read never makes the whole board dance.
      setArrivals(new Set(rows.filter(card => oldColumns.has(card.node.id)
        && oldColumns.get(card.node.id) !== columnOf(card, at)).map(card => card.node.id)));
      const next = { scope, rows, at };
      previous.current = next;
      setSnapshot(next); setReadError(null);
    } catch (cause) {
      if (mine === read.current) setReadError({ scope, text: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [scope]);
  useEffect(() => {
    void load();
    return () => { read.current += 1; };
  }, [load]);
  useEffect(() => {
    const tick = () => { if (!document.hidden) void load(); };
    const timer = window.setInterval(tick, 5_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  const act = async (card: BoardCard, run: () => Promise<unknown>, success: string) => {
    if (operation.current !== null) return;
    operation.current = card.node.id;
    setBusy(card.node.id); setNote(null);
    try {
      await run();
      setNote({nodeId:card.node.id, title:card.node.title, text:success, tone:'ok'});
      await load();
    } catch (cause) {
      setNote({nodeId:card.node.id, title:card.node.title, text:cause instanceof Error ? cause.message : String(cause), tone:'error'});
    } finally { operation.current = null; setBusy(null); }
  };
  const start = (card: BoardCard) => act(card, async () => {
    const launched = await window.wanigan.control.start(card.node.id, {providerId:provider});
    if (launched.sessionId) onOpenSession(launched.sessionId);
  }, 'Task launch accepted.');
  const retry = (card: BoardCard) => act(card, () => window.wanigan.control.retry(card.node.id), 'Task reopened.');
  const park = (card: BoardCard, until: number | null) => act(card,
    () => window.wanigan.control.defer(card.node.id, until),
    until === null ? 'Returned to the task graph.' : `Parked until ${new Date(until).toLocaleDateString()}.`);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = (cards ?? []).filter(card => words.every(word =>
    `${card.node.title} ${card.projectName} ${card.docketTitle} ${card.node.kind}`.toLowerCase().includes(word)));
  const byColumn = new Map<ColumnId, BoardCard[]>(COLUMNS.map(column => [column.id, []]));
  for (const card of matching) byColumn.get(columnOf(card))!.push(card);
  const columns = filter === 'all' ? COLUMNS : COLUMNS.filter(column => column.id === filter);
  const shown = filter === 'all' ? matching.length : byColumn.get(filter)!.length;
  const pick = (card: BoardCard) => setSelection({id:card.node.id, title:card.node.title, scope});
  const clearFilters = () => { setQuery(''); setFilter('all'); };

  if (planning) return <Interview projects={projects} projectId={projectId}
    onCancel={() => { setPlanning(false); void load(); }}
    onDone={id => { setPlanning(false); void load(); onOpenGoal(id); }} />;

  return <div className="pane wide board-view">
    <PageHead compact title="Board" lead="Tasks across your goals. A clear place for what comes next."
      actions={<button className="btn btn-primary" type="button" disabled={!projects.length} onClick={() => setPlanning(true)}><Icon name="plus" />Plan a goal</button>} />
    <div className="brd-toolbar">
      <label className="brd-search"><Icon name="search" /><input className="field" type="search" aria-label="Search board tasks"
        placeholder="Find a task, goal or project" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select className="field brd-scope" aria-label="Filter the board by project" value={scope ?? ''} onChange={event => onPickProject(event.target.value || null)}>
        <option value="">Every project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <button className="btn btn-sm" type="button" onClick={() => void load()}><Icon name="clock" />Refresh</button>
    </div>
    {error && <Note tone="error">The board could not be read: {error}. {cards ? 'Last recorded tasks remain visible. Refresh before changing a task.' : 'Try Refresh to read this project again.'}</Note>}
    {note && note.nodeId !== selected?.node.id && <Note tone={note.tone === 'ok' ? 'ok' : 'error'} onDismiss={() => setNote(null)}><strong>{note.title}:</strong> {note.text}</Note>}
    {cards === null && !error && <Reading what="the board" />}
    {cards !== null && <>
      <div className="brd-filters" role="group" aria-label="Filter tasks by state">
        <Chip pressed={filter === 'all'} count={matching.length} onToggle={() => setFilter('all')}>All tasks</Chip>
        {COLUMNS.map(column => <Chip key={column.id} pressed={filter === column.id} count={byColumn.get(column.id)!.length}
          onToggle={() => setFilter(filter === column.id ? 'all' : column.id)}>{column.label}</Chip>)}
        {(query || filter !== 'all') && <button className="link" type="button" onClick={clearFilters}>Clear filters</button>}
      </div>
      {cards.length === 0 ? <EmptyState posture={scope === null ? 'nothing-yet' : 'nothing-in-scope'}
        title={scope === null ? 'Your next goal starts here.' : 'No tasks in this project.'}
        cue={scope === null ? 'Plan a goal to turn an idea into tasks you can follow and review.' : 'Choose Every project to see work elsewhere.'}
        action={scope === null && projects.length ? <button className="btn btn-primary" type="button" onClick={() => setPlanning(true)}>Plan a goal</button> : undefined} />
        : shown === 0 ? <EmptyState posture="nothing-in-scope" title="No tasks match this view."
          cue="Try another search or show all task states." action={<button className="btn" type="button" onClick={clearFilters}>Show all tasks</button>} />
        : <div className={`brd${filter === 'all' ? '' : ' brd-filtered'}`} aria-label="Task board">
          {columns.map(column => <section key={column.id} className="brd-col" data-column={column.id} aria-label={`${column.label} tasks`}>
            <SectionHead label={column.label} count={byColumn.get(column.id)!.length} />
            <p className="brd-col-why">{column.meaning}</p>
            <div className="brd-cards">
              {!byColumn.get(column.id)!.length && <p className="brd-none">No tasks here</p>}
              {byColumn.get(column.id)!.map(card => <button key={card.node.id} type="button"
                className={`brd-card${card.risk === 'high' ? ' high' : ''}${arrivals.has(card.node.id) ? ' mo-enter' : ''}`}
                data-node-id={card.node.id} aria-haspopup="dialog" onClick={() => pick(card)}>
                <span className="brd-meta"><span className="brd-where">{card.projectName}</span><span>{KIND_WORD[card.node.kind]}</span></span>
                <span className="brd-card-title">{card.node.title}</span>
                <span className="brd-goal">{card.docketTitle}</span>
                <span className="brd-status">
                  {card.node.queued ? <Pill status="Queued for autopilot" tone="warn" />
                    : column.id === 'parked' ? <Pill status={when(card.node.deferUntil!)} tone="quiet" />
                    : <Mark {...markOf(card.node.status)} />}
                  {card.risk === 'high' && <Pill status="High risk" tone="warn" />}
                </span>
                {(card.node.status === 'failed' || card.node.status === 'blocked') && card.node.detail && <span className="brd-why">{card.node.detail}</span>}
                {card.node.status === 'running' && card.node.startedAt !== null && <span className="brd-age">Started {ago(card.node.startedAt)}</span>}
              </button>)}
            </div>
          </section>)}
        </div>}
      <div className="brd-foot"><span>{shown} of {cards.length} tasks · {new Set(cards.map(card => card.docketId)).size} goals</span><span>Updates every 5 seconds</span></div>
    </>}
    <div className="brd-guide"><Explainer id="board-columns" title="How tasks move" defaultHidden>
      Columns follow the goal graph: Waiting means prerequisites are unfinished, while Blocked means a failure needs attention.
      Start launches work; Retry reopens a task. Parked tasks return on their date. Completed and canceled tasks keep their own labels in Closed.
      Open a task for its instructions, prerequisites and actions, or continue to Review for model choices and evidence.
      This view reads up to 500 of the most recently updated goals, keeping every included goal's tasks together.
    </Explainer></div>
    {selection && <TaskSheet selection={selection} card={selected} cards={cards ?? []} busy={busy} stale={!!error}
      note={note?.nodeId === selected?.node.id ? note : null} provider={provider} providers={launchable} providerAvailable={providerAvailable}
      onProvider={setProvider} onClose={() => setSelection(null)} onPick={pick} onStart={start} onRetry={retry} onPark={park}
      onOpenGoal={onOpenGoal} onOpenSession={onOpenSession} onRefresh={() => void load()} />}
  </div>;
}

function TaskSheet({selection,card,cards,busy,stale,note,provider,providers,providerAvailable,onProvider,onClose,onPick,onStart,onRetry,onPark,onOpenGoal,onOpenSession,onRefresh}: {
  selection: Selection; card: BoardCard | null; cards: BoardCard[]; busy: string | null; stale: boolean; note: ActionNote | null;
  provider: string; providers: ProviderInfo[]; providerAvailable: boolean; onProvider: (id:string)=>void; onClose:()=>void;
  onPick:(card:BoardCard)=>void; onStart:(card:BoardCard)=>Promise<void>; onRetry:(card:BoardCard)=>Promise<void>;
  onPark:(card:BoardCard,until:number|null)=>Promise<void>; onOpenGoal:(id:string)=>void; onOpenSession:(id:string)=>void; onRefresh:()=>void;
}) {
  const {portal,backdropProps,dialogProps} = useDialog<HTMLDivElement>({onClose,initialFocus:'least-destructive'});
  const title = useRef<HTMLHeadingElement>(null);
  const previousTask = useRef(selection.id);
  useEffect(() => {
    if (previousTask.current !== selection.id) title.current?.focus();
    previousTask.current = selection.id;
  }, [selection.id]);
  const disabled = busy !== null || stale;
  const parked = card ? columnOf(card) === 'parked' : false;
  return portal(<div {...backdropProps} className={`${backdropProps.className} brd-backdrop`}>
    <div {...dialogProps} className="brd-sheet" aria-labelledby="brd-task-title">
      <div className="brd-sheet-toolbar"><span>Task details</span><button className="btn btn-sm" type="button" aria-label="Close task details" data-initial-focus onClick={onClose}><Icon name="x" /></button></div>
      <div className="brd-sheet-body" key={card?.node.id ?? selection.id}>
        <h2 id="brd-task-title" ref={title} tabIndex={-1}>{card?.node.title ?? selection.title}</h2>
        {!card ? <Note tone="info">This task is no longer in the current board reading. Close this sheet or refresh the board to find its latest record.</Note> : <>
          <p className="brd-sheet-context">{card.projectName} · {card.docketTitle}</p>
          <div className="brd-status"><Mark {...markOf(card.node.status)} /><Pill status={KIND_WORD[card.node.kind]} tone="quiet" /><Pill status={RISK_WORD[card.risk]} tone={card.risk === 'high' ? 'warn' : 'quiet'} /></div>
          {note && <Note tone={note.tone === 'ok' ? 'ok' : 'error'}>{note.text}</Note>}
          {stale && <Note tone="error">The board could not refresh. Read it again before changing this task.</Note>}
          {card.node.detail && <Note tone={card.node.status === 'failed' ? 'error' : 'info'}>{card.node.detail}</Note>}
          <section className="brd-detail"><SectionHead label="Instructions" /><p className="brd-instructions">{card.node.instructions || 'No instructions were recorded.'}</p></section>
          <section className="brd-detail"><SectionHead label="Prerequisites" count={card.node.dependsOn.length} />
            {!card.node.dependsOn.length ? <p className="dim">No prerequisites.</p> : <ul className="brd-dependencies">{card.node.dependsOn.map(id => {
              const dependency = cards.find(row => row.node.id === id && row.docketId === card.docketId);
              return <li key={id}>{dependency ? <button type="button" onClick={()=>onPick(dependency)}><span>{dependency.node.title}</span><Mark {...markOf(dependency.node.status)} /><Icon name="chevron-right" /></button> : <span>Task {id} is not in this reading.</span>}</li>;
            })}</ul>}
          </section>
          {(card.node.providerId || card.node.startedAt || card.node.endedAt || card.node.claimPath) && <dl className="brd-facts">
            {card.node.providerId && <><dt>Agent</dt><dd>{card.node.providerId}{card.node.model ? ` · ${card.node.model}` : ''}</dd></>}
            {card.node.startedAt !== null && <><dt>Started</dt><dd>{new Date(card.node.startedAt).toLocaleString()}</dd></>}
            {card.node.endedAt !== null && <><dt>Ended</dt><dd>{new Date(card.node.endedAt).toLocaleString()}</dd></>}
            {card.node.claimPath && <><dt>Planned file claim</dt><dd className="mono">{card.node.claimPath}</dd></>}
          </dl>}
          <section className="brd-detail"><SectionHead label="Next action" />
            {card.node.queued && <Note tone="warn">Queued for autopilot. The dispatcher owns its next launch.</Note>}
            {parked && <p className="dim">{when(card.node.deferUntil!)} · {new Date(card.node.deferUntil!).toLocaleString()}</p>}
            {!parked && card.node.status === 'ready' && !card.node.queued && <div className="brd-launch">
              {providers.length ? <select className="field" aria-label="Which agent Start launches on" value={provider} disabled={busy !== null} onChange={event=>onProvider(event.target.value)}>
                {providers.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}
              </select> : <p className="dim">No installed agent is available. Add one in Settings.</p>}
              <button className="btn btn-primary" type="button" disabled={disabled || !providerAvailable} onClick={()=>void onStart(card)}><Icon name="play" />{busy===card.node.id?'Starting…':'Start task'}</button>
            </div>}
            <div className="brd-acts">
              {parked && <button className="btn" type="button" disabled={disabled} onClick={()=>void onPark(card,null)}>Bring back now</button>}
              {['failed','canceled'].includes(card.node.status) && <button className="btn" type="button" disabled={disabled} onClick={()=>void onRetry(card)}>{busy===card.node.id?'Reopening…':'Retry task'}</button>}
              {card.node.sessionId && <button className="btn" type="button" onClick={()=>onOpenSession(card.node.sessionId!)}>Open session</button>}
              <button className="btn" type="button" onClick={()=>onOpenGoal(card.docketId)}>Open goal in Review<Icon name="external" /></button>
            </div>
            {!parked && !['running','completed'].includes(card.node.status) && !card.node.queued && <details className="brd-park-menu">
              <summary>Park for later<Icon name="chevron-down" /></summary>
              <div className="brd-park-row">{PARK_FOR.map(preset=><button className="btn btn-sm" key={preset.label} type="button" disabled={disabled} onClick={()=>void onPark(card,Date.now()+preset.ms)}>{preset.label}</button>)}</div>
            </details>}
          </section>
        </>}
        {(stale || !card) && <button className="btn" type="button" onClick={onRefresh}>Refresh board</button>}
      </div>
    </div>
  </div>);
}
