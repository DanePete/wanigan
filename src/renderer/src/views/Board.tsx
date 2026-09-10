import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardCard, DocketNodeStatus, Project, ProviderInfo } from '@shared/types';
import { EmptyState, Explainer, Note, PageHead, Reading, ago } from '../components/bits';
import Interview from './Interview';

/**
 * Every ticket in the app, in columns.
 *
 * Control already shows one goal properly: its contract, its task graph, the
 * evidence and the decision waiting on you. This answers a different question,
 * and the difference is why it is a tab rather than a panel inside that one.
 * Control asks "how is this goal going"; the board asks "what is outstanding
 * across everything, and what am I doing about it today" — which spans goals
 * and projects, and cannot be a view of one of them.
 *
 * There is no ticket table behind this. A card is a work_node read a second
 * way: its column is the status the goal's own dependency graph derives, and
 * moving one is the same call Control makes. Two stores that both claimed to
 * hold the tickets would disagree inside a week, and the one on screen would be
 * the wrong one.
 *
 * The column that earns the board its keep is Parked. A backlog needs somewhere
 * to put "not now, but not never", and without one every known issue has to be
 * either in progress or forgotten — which is how a list of things to fix
 * becomes a graveyard. Parking takes a date rather than a flag, so a ticket
 * comes back on its own instead of waiting to be remembered.
 */

type Column = {
  id: string;
  label: string;
  /** Which derived statuses land here. */
  holds: DocketNodeStatus[];
  /** One sentence about what being in this column means. */
  meaning: string;
};

/**
 * Five columns, and the mapping is the whole design decision.
 *
 * 'pending' and 'blocked' are deliberately not the same column even though the
 * graph derives both from unmet dependencies: a task waiting on one that has
 * not run yet is ordinary, and a task waiting on one that *failed* is a
 * problem. Collapsing them is how a stuck goal looks like a busy one.
 */
const COLUMNS: readonly Column[] = [
  { id: 'parked', label: 'Parked', holds: [], meaning: 'Deliberately not now. Each one carries the date it comes back.' },
  { id: 'ready', label: 'Ready', holds: ['ready'], meaning: 'Every prerequisite is done. These can start.' },
  { id: 'running', label: 'In progress', holds: ['running'], meaning: 'An agent is working on it right now.' },
  { id: 'blocked', label: 'Blocked', holds: ['blocked', 'failed'], meaning: 'Waiting on something unfinished, or stopped on a failure.' },
  { id: 'done', label: 'Done', holds: ['completed', 'canceled'], meaning: 'Finished or abandoned. Kept so the record is complete.' },
];

/** Presets for parking. Named as the intent, not the arithmetic. */
const PARK_FOR: { label: string; ms: number }[] = [
  { label: 'tomorrow', ms: 24 * 60 * 60_000 },
  { label: 'next week', ms: 7 * 24 * 60 * 60_000 },
  { label: 'next month', ms: 30 * 24 * 60 * 60_000 },
  { label: 'next quarter', ms: 90 * 24 * 60 * 60_000 },
];

const RISK_WORD: Record<string, string> = { low: 'low risk', elevated: 'elevated risk', high: 'high risk' };

function when(at: number): string {
  const days = Math.round((at - Date.now()) / 86_400_000);
  if (days <= 0) return 'due now';
  if (days === 1) return 'back tomorrow';
  if (days < 14) return `back in ${days} days`;
  if (days < 60) return `back in ${Math.round(days / 7)} weeks`;
  return `back ${new Date(at).toLocaleDateString()}`;
}

export default function Board({ projects, providers, projectId, selectedProjectId, onPickProject, onOpenGoal, onOpenSession }: {
  projects: Project[];
  providers: ProviderInfo[];
  /** The shell's selected project, used only as the interview's default. */
  projectId: string | null;
  selectedProjectId: string | null;
  onPickProject: (id: string | null) => void;
  onOpenGoal: (docketId: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  // The interview takes the whole pane rather than opening a dialog. It is ten
  // minutes of typing with a running cost on screen, and a modal over the board
  // would be both too small for the transcript and too easy to dismiss by
  // accident partway through something the operator has paid for.
  const [planning, setPlanning] = useState(false);
  // One provider for the whole board rather than a picker on every card.
  // Starting a ticket from here is the "get on with it" path — the operator who
  // wants to choose a model per task has the Goal screen, which offers effort
  // and permission mode as well. A dropdown on forty cards would be forty
  // chances to pick the wrong one.
  const launchable = useMemo(() => providers.filter((provider) => !!provider.path), [providers]);
  const [provider, setProvider] = useState('');
  useEffect(() => {
    if (launchable.length && !launchable.some((p) => p.id === provider)) setProvider(launchable[0].id);
  }, [launchable, provider]);
  const [cards, setCards] = useState<BoardCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Null means every project. The board's whole point is the cross-project
  // view, so it starts there rather than inheriting the shell's selection —
  // but the filter is one click away for somebody who wants one repository.
  const scope = selectedProjectId;
  const setScope = onPickProject;

  // Which read is the current one. Two are in flight whenever the operator
  // changes the filter while the five-second poll is out, and they come back in
  // whatever order the main process finishes them — so without this the answer
  // for "every project" can land after the answer for one repository and leave
  // the board showing tickets the filter above it says are hidden.
  const read = useRef(0);
  const load = useCallback(() => {
    const mine = read.current + 1;
    read.current = mine;
    window.wanigan.control.board(scope, 500)
      .then((rows) => { if (mine !== read.current) return; setCards(rows); setError(null); })
      .catch((e) => { if (mine !== read.current) return; setError(e instanceof Error ? e.message : String(e)); });
  }, [scope]);

  useEffect(() => { load(); }, [load]);
  // The columns move because agents finish, not because this view did
  // something. A board that only refreshed on its own clicks would show a
  // ticket as running for as long as you left the tab open.
  useEffect(() => {
    // Paused while the window is hidden. The board is a background tab most of
    // the day, and a five-second query across every goal in every project is
    // not something to run against a laptop nobody is looking at. Reading once
    // on the way back is what keeps that from showing a stale board.
    const tick = () => { if (!document.hidden) load(); };
    const timer = window.setInterval(tick, 5_000);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  const start = useCallback(async (card: BoardCard) => {
    if (!provider) { setNote('No provider is installed, so nothing can be launched from here.'); return; }
    setBusy(card.node.id); setNote(null);
    try {
      const launched = await window.wanigan.control.start(card.node.id, { providerId: provider });
      load();
      if (launched.sessionId) onOpenSession(launched.sessionId);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }, [provider, load, onOpenSession]);

  const retry = useCallback(async (card: BoardCard) => {
    setBusy(card.node.id); setNote(null);
    try {
      await window.wanigan.control.retry(card.node.id);
      setNote('Reopened. It is back in Ready, and its claim on the working tree is released.');
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }, [load]);

  const park = useCallback(async (nodeId: string, until: number | null) => {
    setBusy(nodeId); setNote(null);
    try {
      await window.wanigan.control.defer(nodeId, until);
      setNote(until === null ? 'Back in play.' : `Parked until ${new Date(until).toLocaleDateString()}.`);
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }, [load]);

  // Parked is computed here rather than being a status, because a parked date
  // that has passed is simply due: the derived status already says 'ready', and
  // a card that stayed in Parked until something swept it would be a promise
  // the board quietly failed to keep.
  const byColumn = useMemo(() => {
    const out = new Map<string, BoardCard[]>(COLUMNS.map((column) => [column.id, []]));
    for (const card of cards ?? []) {
      const parked = card.node.deferUntil !== null && card.node.deferUntil > Date.now()
        && card.node.status !== 'running' && card.node.status !== 'completed';
      const column = parked
        ? 'parked'
        : COLUMNS.find((c) => c.holds.includes(card.node.status))?.id ?? 'blocked';
      out.get(column)!.push(card);
    }
    return out;
  }, [cards]);

  const total = cards?.length ?? 0;

  if (planning) {
    return (
      <Interview
        projects={projects}
        projectId={projectId}
        onCancel={() => { setPlanning(false); load(); }}
        onDone={(docketId) => { setPlanning(false); load(); onOpenGoal(docketId); }}
      />
    );
  }

  return (
    <div className="pane">
      <PageHead
        eyebrow="Work"
        title="Board"
        lead="Every ticket across every goal. Move one by acting on it, or park it for a date it should come back."
        actions={(
          <>
            <select className="field brd-scope" aria-label="Filter the board by project"
                    value={scope ?? ''} onChange={(e) => setScope(e.target.value || null)}>
              <option value="">Every project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
            {launchable.length > 0 && (
              <select className="field brd-scope" aria-label="Which agent Start launches on"
                      value={provider} onChange={(e) => setProvider(e.target.value)}>
                {launchable.map((row) => (
                  <option key={row.id} value={row.id}>Start on {row.label}</option>
                ))}
              </select>
            )}
            <button className="btn btn-primary" type="button" disabled={projects.length === 0}
                    onClick={() => setPlanning(true)}>
              Plan a goal
            </button>
          </>
        )}
      />

      {error && <Note tone="error">The board could not be read: {error}</Note>}
      {note && <Note tone="info">{note}</Note>}

      {cards === null && !error && <Reading what="the board" />}

      {cards !== null && total === 0 && (
        <EmptyState
          posture={scope === null ? 'nothing-yet' : 'nothing-in-scope'}
          title={scope === null ? 'No tickets yet.' : 'No tickets in this project.'}
          cue={scope === null
            ? 'A ticket is a task inside a goal. Plan one and its tasks appear here, across every project at once.'
            : 'Other projects may have tickets. Switch the filter above to Every project to see them.'}
          action={scope === null && projects.length > 0
            ? <button className="btn btn-primary" type="button" onClick={() => setPlanning(true)}>Plan a goal</button>
            : undefined}
        />
      )}

      {cards !== null && total > 0 && (
        <>
          <div className="brd">
            {COLUMNS.map((column) => {
              const rows = byColumn.get(column.id) ?? [];
              return (
                <section key={column.id} className="brd-col" aria-label={`${column.label}, ${rows.length} tickets`}>
                  <header className="brd-col-head">
                    <h2>{column.label}</h2>
                    <span className="brd-count">{rows.length}</span>
                  </header>
                  <p className="brd-col-why">{column.meaning}</p>
                  <div className="brd-cards">
                    {rows.length === 0 && <p className="brd-none">Nothing here.</p>}
                    {rows.map((card) => (
                      <article key={card.node.id} className={`brd-card${card.risk === 'high' ? ' high' : ''}`}>
                        <button className="brd-card-title" type="button"
                                title="Open this goal in Review"
                                onClick={() => onOpenGoal(card.docketId)}>
                          {card.node.title}
                        </button>
                        <div className="brd-meta">
                          <span className="brd-where">{card.projectName}</span>
                          <span aria-hidden="true"> · </span>
                          <span>{card.docketTitle}</span>
                        </div>
                        <div className="brd-chips">
                          <span className="brd-chip">{card.node.kind}</span>
                          {card.risk !== 'elevated' && <span className="brd-chip">{RISK_WORD[card.risk] ?? card.risk}</span>}
                          {card.node.queued && <span className="brd-chip warn">queued for autopilot</span>}
                          {card.node.deferUntil !== null && card.node.deferUntil > Date.now() && (
                            <span className="brd-chip">{when(card.node.deferUntil)}</span>
                          )}
                          {card.node.startedAt !== null && card.node.status === 'running' && (
                            <span className="brd-chip">started {ago(card.node.startedAt)}</span>
                          )}
                        </div>
                        {/* The failure reason, on the card. A blocked column
                            that makes you open something to find out why is a
                            column you stop reading. */}
                        {card.node.status === 'failed' && card.node.detail && (
                          <p className="brd-why">{card.node.detail}</p>
                        )}
                        <div className="brd-acts">
                          {/* Start where it can start, Retry where it failed.
                              Both go through the same calls the Goal screen
                              makes — a board that could move a card by a route
                              of its own would be a second way for a ticket to
                              change state, and the two would disagree. */}
                          {/* Never in Parked, even though a parked task's derived
                              status is what keeps it out of Ready anyway. "Not
                              now" and a Start button on the same card are a
                              contradiction, and the column already offers the
                              honest version of that thought: bring it back
                              first, then start it. Gating on the column as well
                              as the status means a change to how deferral is
                              derived cannot put the two side by side. */}
                          {column.id !== 'parked' && card.node.status === 'ready' && !card.node.queued && (
                            <button className="btn btn-sm btn-primary" type="button"
                                    disabled={busy !== null || !provider}
                                    title={provider ? `Launch this task on ${launchable.find((p) => p.id === provider)?.label ?? provider}` : 'No provider is installed'}
                                    onClick={() => void start(card)}>
                              {busy === card.node.id ? 'Starting…' : 'Start'}
                            </button>
                          )}
                          {(card.node.status === 'failed' || card.node.status === 'canceled') && (
                            <button className="btn btn-sm" type="button" disabled={busy !== null}
                                    onClick={() => void retry(card)}>
                              {busy === card.node.id ? 'Reopening…' : 'Retry'}
                            </button>
                          )}
                          {column.id === 'parked' ? (
                            <button className="btn btn-sm" type="button" disabled={busy !== null}
                                    onClick={() => void park(card.node.id, null)}>
                              Bring back now
                            </button>
                          ) : card.node.status !== 'running' && card.node.status !== 'completed' ? (
                            // Behind a disclosure rather than four buttons on
                            // every card. A board is read by scanning titles,
                            // and an action row repeated down a column is the
                            // thing the eye has to get past to do that — the
                            // cards were taller than their own titles. Native
                            // <details>, so it needs no state and answers to a
                            // keyboard without any of this view's help.
                            <details className="brd-park-menu">
                              <summary aria-label={`Park ${card.node.title} for later`}>Park…</summary>
                              <div className="brd-park-row">
                                {PARK_FOR.map((preset) => (
                                  <button key={preset.label} className="brd-park" type="button" disabled={busy !== null}
                                          aria-label={`Park ${card.node.title} until ${preset.label}`}
                                          onClick={() => void park(card.node.id, Date.now() + preset.ms)}>
                                    {preset.label}
                                  </button>
                                ))}
                              </div>
                            </details>
                          ) : null}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>

          <Explainer id="board-columns" title="Why a ticket cannot simply be dragged between columns">
            A column here is not a label somebody set — it is derived from the goal&apos;s own dependency
            graph every time this reads. A task is Ready because everything it depends on completed, and
            In&nbsp;progress because an agent is running. Dragging a card into Done would be writing down an
            outcome nobody produced, which is the one thing a board over real work must not let you do.
            Parking is the exception, and the only column you move a card into by choice: it is a decision
            about <em>when</em>, not a claim about what happened. <strong>Start</strong> and <strong>Retry</strong>
            move a card by doing the work — they launch an agent and reopen a failed task, through the same
            calls the Goal screen makes, so the column follows the outcome rather than announcing one.
            For a task that needs a particular model, effort or permission mode, open its goal: this board
            launches on one agent so that starting something is one click rather than four.
          </Explainer>
        </>
      )}
    </div>
  );
}
