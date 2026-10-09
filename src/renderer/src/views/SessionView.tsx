import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { CARD_TYPES, LIVE_STATES, type CardType, type ProjectSummary, type Provider, type SessionEvent } from '@shared/model';
import { receivesLine } from '@shared/attachments';
import { CHATTER_TOOL, chatterLine, decodeChatter } from '@shared/chatter';
import { groupTurns, turnLength, type Turn } from '@shared/turns';
import type { Checkpoint, SessionCheckpoints } from '@shared/checkpoints';
import { TurnChange, TurnPanel, UndoDialog } from './TurnChanges';
import { attempt, call, forProject, useQuery } from '../lib/api';
import { useDraft } from '../lib/draft';
import { href, navigate, openCard } from '../lib/router';
import { PROVIDER_LABEL, TYPE_LABEL, ago, duration } from '../lib/format';
import { Icon } from '../components/icons';
import { Button, Dialog, Field, IconButton, ProjectMark, Segmented, StateMark, useSingleFlight, useToast } from '../components/ui';
import { Terminal } from '../components/Terminal';
import { ContinueOn } from '../components/ContinueOn';
import { SessionTokens } from '../components/Tokens';
import { Ask } from '../components/Ask';
import { AttachButton, AttachmentChips, useAttachments, useFileDrop } from '../components/Attachments';
import { LivePane } from '../components/Live';
import { useLiveSplit, useSessionEdits } from '../lib/live';
import { useAppState } from '../lib/settings';
import { liveFor } from '@shared/settings';
import { limitDetail } from '@shared/limits';
import { RUNTIME_LABEL, localModelLabel, parseLocalModel } from '@shared/local-models';

export function SessionView({ project, sessionId }: { project: ProjectSummary; sessionId: string }) {
  const data = useQuery('sessions.get', { id: sessionId }, ['sessions'], (_e, d) => (d as { sessionId?: string })?.sessionId === sessionId);
  const cards = useQuery('cards.list', { projectId: project.id }, ['board'], (_e, d) => (d as { projectId?: string })?.projectId === project.id);
  const toast = useToast();
  const main = useRef<HTMLDivElement>(null);
  const [timeline, setTimeline] = useState(true);
  const [promoting, setPromoting] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const session = data.data?.session;
  const live = !!session && LIVE_STATES.has(session.state);
  const card = session?.cardId ? cards.data?.find((c) => c.id === session.cardId) : undefined;
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const account = session?.accountId ? accounts.data?.find((a) => a.id === session.accountId) : undefined;
  // What git recorded per turn. Agents only: a shell has no turns.
  const checkpoints = useQuery('sessions.checkpoints', session && session.provider !== 'shell' ? { id: sessionId } : null, ['sessions'],
    (_e, d) => (d as { sessionId?: string })?.sessionId === sessionId);
  const [turnOpen, setTurnOpen] = useState<{ checkpoint: Checkpoint; label: string } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const last = checkpoints.error ? null : checkpoints.data?.last ?? null;
  // The live view beside the terminal, following this session's edits (Settings › Live view).
  const settings = useAppState().state?.settings;
  const site = useQuery('live.site', settings?.liveView ? { projectId: project.id } : null, ['liveSite', 'projects'], forProject(project.id));
  const siteUrl = settings && site.data?.url && liveFor(settings, site.data.platform) ? site.data.url : null;
  const [split, setSplit] = useLiveSplit();
  const showLive = !!siteUrl && split;
  const edits = useSessionEdits(project.id, sessionId, siteUrl ? site.data?.servedPath ?? project.path : null);
  const [outlineFirst, setOutlineFirst] = useState<string[] | null>(null);
  const seeIt = (): void => { setOutlineFirst(edits.paths); edits.clear(); setSplit(true); };

  // Opening a session is seeing it: it settles "finished a turn" and "failed".
  useEffect(() => {
    if (session && (session.state === 'waiting' || session.state === 'failed' || session.state === 'interrupted')) {
      void call('sessions.seen', { id: session.id }).catch(() => {});
    }
  }, [session?.id, session?.state, session?.lastEventAt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setConfirmStop(false); setTurnOpen(null); setUndoing(false); }, [sessionId]);

  if (data.error) return <div className="view-pad error-text">{data.error.message}</div>;
  if (!session) return <div className="view-pad faint">Opening the session…</div>;

  return (
    <section className="view session" aria-labelledby="session-title">
      <header className="topbar session-bar">
        <div className="topbar-title">
          <a className="back" href={href({ name: 'project', projectKey: project.key, view: 'sessions' })} aria-label={`Back to ${project.name} sessions`}>
            <Icon name="back" />
          </a>
          <ProjectMark projectKey={project.key} size="s" />
          <SessionTitle id={session.id} title={session.title} />
          <StateMark state={session.state} />
        </div>
        <div className="session-facts">
          <span>{PROVIDER_LABEL[session.provider]}{account ? <span className="faint"> as {account.label}</span> : null}</span>
          {session.model || session.effort ? (
            <span className="mono small" title="The model and effort this session was started with">{[localModelLabel(session.model) ?? session.model, session.effort].filter(Boolean).join(' · ')}</span>
          ) : null}
          {parseLocalModel(session.model) ? (
            <span className="remote-mark" title={`The model runs on this Mac through ${RUNTIME_LABEL[parseLocalModel(session.model)!.runtime]}: prompts and code go to it, not to a model provider, and no plan’s limits apply.`}>
              <Icon name="local" size={14} /><span className="remote-mark-label">On this Mac</span>
            </span>
          ) : null}
          <SessionTokens sessionId={session.id} />
          {session.remote ? (
            <span className="remote-mark" title="Started with Claude Code’s Remote Control, as you asked. If your account is eligible, Anthropic relays this session to claude.ai and the Claude app; the terminal shows whether it connected.">
              <Icon name="remote" size={14} /><span className="remote-mark-label">Remote Control</span>
            </span>
          ) : null}
          {card ? <button type="button" className="linkish mono" onClick={() => openCard(card.key)}>{card.key}</button> : <span className="faint">One-off</span>}
          <span className="faint">{live ? `running ${duration(session.startedAt)}` : `ended ${ago(session.endedAt)}`}</span>
        </div>
        <div className="topbar-tools">
          {!card ? <Button icon="promote" onClick={() => setPromoting(true)}>Make this a card</Button> : null}
          {live ? (
            confirmStop ? (
              <>
                <Button tone="danger" icon="stop" onClick={() => attempt(() => call('sessions.stop', { id: session.id }), (m) => toast(m, 'error')).then(() => setConfirmStop(false))}>Stop it</Button>
                <Button tone="quiet" onClick={() => setConfirmStop(false)}>Keep running</Button>
              </>
            ) : <Button tone="quiet" icon="stop" onClick={() => setConfirmStop(true)}>Stop</Button>
          ) : null}
          {siteUrl && !showLive && edits.paths ? (
            <Button size="s" tone="quiet" icon="live" className="live-chip" onClick={seeIt}
              title={`This session changed ${edits.paths.map((p) => p.split('/').pop()).join(', ')}: open the site beside the terminal, with what it made outlined`}>
              {edits.paths[0]?.split('/').pop()} changed · See it
            </Button>
          ) : null}
          {siteUrl ? (
            <IconButton icon="live" label={showLive ? 'Hide the live view' : 'Show the site beside the terminal'}
              onClick={() => { if (showLive) setSplit(false); else seeIt(); }} aria-pressed={showLive} />
          ) : null}
          <IconButton icon="activity" label={timeline ? 'Hide the timeline' : 'Show the timeline'} onClick={() => setTimeline((t) => !t)} aria-pressed={timeline} />
        </div>
      </header>

      {session.state === 'permission' ? (
        <div className="banner banner-amber banner-asks">
          <p className="banner-text"><Icon name="alert" size={15} /> {session.activity ?? 'The agent is asking for permission.'} Answer it in the terminal.</p>
          {session.asks?.length ? <div className="need-asks">{session.asks.map((ask, i) => <Ask key={`${i}-${ask.tool}`} ask={ask} />)}</div> : null}
        </div>
      ) : null}
      {session.state === 'limited' ? (
        <div className="banner banner-amber banner-limit">
          <Icon name="alert" size={15} />
          <span className="banner-text">
            {limitDetail(session.limit?.resetsAt ?? null, Date.now(), account?.label)}
            {session.activity ? <span className="faint"> {session.provider === 'claude' ? 'Claude' : PROVIDER_LABEL[session.provider]} said: “{session.activity}”</span> : null}
            {session.provider === 'gemini' ? <span className="faint"> Gemini asks in its terminal whether to keep trying, switch model or stop.</span> : null}
          </span>
          {session.provider === 'claude' ? <ContinueOn sessionId={session.id} accountId={session.accountId} projectKey={project.key} /> : null}
        </div>
      ) : null}
      {!live ? (
        <div className={`banner ${session.state === 'ended' ? 'banner-quiet' : 'banner-red'}`}>
          <span className="banner-text">
            {session.activity ?? 'This session has ended.'}{session.exitCode !== null ? ` (exit code ${session.exitCode})` : ''}. Its output is kept below.
          </span>
          {session.provider !== 'shell' && session.conversationId ? (
            <Button size="s" tone="primary" icon="resume" disabled={!!project.pausedAt}
              title={project.pausedAt ? 'Resume the project first' : 'Continue this conversation in a new session, with the same account'}
              onClick={function resume(): Promise<void> {
                return attempt(() => call('sessions.resume', { id: session.id }), (m) => toast(m, 'error', { action: { label: 'Retry', run: () => void resume() } }))
                  .then((s) => { if (s) navigate({ name: 'session', projectKey: project.key, sessionId: s.id }); });
              }}>
              Resume conversation
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className={`session-body${timeline ? ' with-timeline' : ''}${showLive ? ' with-live' : ''}`}>
        <div className="session-main" ref={main} inert={turnOpen ? true : undefined}>
          <Terminal sessionId={session.id} live={live} />
          {live ? <Composer sessionId={session.id} provider={session.provider} state={session.state} zone={main} /> : null}
        </div>
        {showLive ? (
          <div className="session-live">
            <LivePane project={project} follow={session.id} card={session.cardId ? { id: session.cardId, key: session.cardKey ?? 'the card' } : null} compact outlineFirst={outlineFirst} />
          </div>
        ) : null}
        {turnOpen ? (
          <TurnPanel session={session} projectId={project.id} checkpoint={turnOpen.checkpoint} label={turnOpen.label}
            last={last && last.eventId === turnOpen.checkpoint.eventId ? last : null}
            onUndo={() => setUndoing(true)} onClose={() => setTurnOpen(null)} />
        ) : null}
        {timeline ? (
          <Timeline events={data.data?.events ?? []} checkpoints={checkpoints.error ? undefined : checkpoints.data}
            error={checkpoints.error} onRetry={checkpoints.reload}
            openId={turnOpen?.checkpoint.id ?? null} onOpen={(checkpoint, label) => setTurnOpen({ checkpoint, label })} onUndo={() => setUndoing(true)} />
        ) : null}
      </div>

      {promoting ? <PromoteDialog sessionId={session.id} title={session.title} onClose={() => setPromoting(false)} /> : null}
      {undoing && last ? <UndoDialog session={session} last={last} onClose={() => setUndoing(false)} /> : null}
    </section>
  );
}

/**
 * Message the agent. Images and files pasted or dropped on the terminal or
 * here, or picked with the paperclip, wait as chips and go with the message.
 */
function Composer({ sessionId, provider, state, zone }: { sessionId: string; provider: Provider; state: string; zone: RefObject<HTMLDivElement | null> }) {
  const { text, setText, clear } = useDraft();
  const toast = useToast();
  const takesFiles = provider !== 'shell';
  const attach = useAttachments(takesFiles ? { session: sessionId } : null);
  useFileDrop(zone, (files) => { if (takesFiles) void attach.add(files); else toast('A shell takes no attachments.', 'error'); });
  const waits = provider === 'claude' && state !== 'waiting';
  const ids = attach.files.map((f) => f.id);
  const once = useSingleFlight();
  const send = (): Promise<void> => once(async () => {
    if (!text.trim() && !ids.length) return;
    // The text stays in the box when sending fails, so Retry sends it again.
    const r = await attempt(() => call('sessions.queue', { id: sessionId, text, ...(ids.length ? { attachments: ids } : {}) }),
      (m) => toast(m, 'error', { action: { label: 'Retry', run: () => void send() } }));
    if (r) {
      clear();
      if (r.queued) toast(`Queued. It goes to the agent when it is next idle (${r.queued} waiting).`);
    }
  });
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {attach.files.length || attach.adding ? (
        <div className="composer-files">
          <AttachmentChips files={attach.files} adding={attach.adding} onRemove={attach.remove} />
          <p className="attach-note" title={provider === 'claude'
            ? 'Claude Code reads a pasted image path itself, with no permission prompt, unless your settings deny reading there; then it gets the path as text.'
            : undefined}>{receivesLine(provider)}</p>
        </div>
      ) : null}
      <div className="composer-row">
        {takesFiles ? <AttachButton onPick={attach.pick} /> : null}
        <label className="visually-hidden" htmlFor="composer">Message the agent</label>
        <textarea
          id="composer"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={waits ? 'Message the agent. It is sent when the agent is idle.' : 'Message the agent'}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <Button tone="primary" type="submit" icon="send" disabled={(!text.trim() && !ids.length) || attach.adding > 0}>{waits ? 'Queue' : 'Send'}</Button>
      </div>
    </form>
  );
}

const EVENT_LABEL: Record<string, string> = {
  SessionStart: 'Started', UserPromptSubmit: 'Prompt', PreToolUse: 'Tool', PostToolUse: 'Done', PostToolUseFailure: 'Tool failed',
  PermissionRequest: 'Asked', PermissionDenied: 'Denied', Notification: 'Notice', Stop: 'Turn ended', StopFailure: 'Turn failed',
  PreCompact: 'Compacting', PostCompact: 'Compacted', SessionEnd: 'Session end', Undo: 'Undone', Redo: 'Redone',
};

function Timeline({ events, checkpoints, error, onRetry, openId, onOpen, onUndo }: {
  events: SessionEvent[];
  checkpoints: SessionCheckpoints | undefined;
  error: Error | null;
  onRetry: () => void;
  /** The checkpoint whose changes are open over the terminal. */
  openId: number | null;
  onOpen: (checkpoint: Checkpoint, label: string) => void;
  onUndo: () => void;
}) {
  const turns = groupTurns(events).slice(-60).reverse();
  // Each turn's checkpoint is the one its Stop event took.
  const byEvent = new Map((checkpoints?.checkpoints ?? []).filter((c) => c.kind === 'turn' && c.eventId !== null).map((c) => [c.eventId as number, c]));
  const baseline = checkpoints?.checkpoints.find((c) => c.kind === 'start')?.notCaptured ?? null;
  return (
    <aside className="timeline" aria-label="What the agent did">
      <h2>Timeline</h2>
      {error ? <div className="timeline-note" role="alert">
        <p className="error-text">{error.message}</p>
        <Button size="s" icon="refresh" onClick={onRetry}>Retry</Button>
      </div> : null}
      {baseline ? <p className="timeline-note faint">Turns are not checkpointed here: {baseline}.</p> : null}
      {turns.length ? (
        <ol className="turns">
          {turns.map((t, i) => {
            const checkpoint = t.events.map((e) => byEvent.get(e.id)).filter(Boolean).at(-1) ?? null;
            const label = checkpoint ? (checkpoint.turn ? `Turn ${checkpoint.turn}` : 'Start') : t.n ? `Turn ${t.n}` : 'Start';
            const last = checkpoints?.last && t.events.some((e) => e.id === checkpoints.last?.eventId) ? checkpoints.last : null;
            return (
              <TurnRow key={t.events[0]?.id ?? i} turn={t} open={i === 0} label={label}
                change={checkpoint ? <TurnChange checkpoint={checkpoint} baseline={baseline} last={last} open={checkpoint.id === openId} onOpen={() => onOpen(checkpoint, label)} onUndo={onUndo} /> : null} />
            );
          })}
        </ol>
      ) : <p className="faint small">Hook events appear here as the agent works. Shells and agents without hooks have none.</p>}
    </aside>
  );
}

/** One turn: what it took, what it touched, then each step. The newest is open. What git saw it change sits under it. */
function TurnRow({ turn, open, label, change }: { turn: Turn; open: boolean; label: string; change: ReactNode }) {
  const steps = turn.events.filter((e) => e.event !== 'PostToolUse' && e.event !== 'UserPromptSubmit');
  const facts = [
    turn.n === 0 ? null : turn.endedAt ? turnLength(turn.startedAt, turn.endedAt) : 'going',
    turn.tools ? `${turn.tools} tool${turn.tools === 1 ? '' : 's'}` : null,
    // Git's count, under the turn, replaces the edit tools' own.
    turn.files.length && !change ? `${turn.files.length} file${turn.files.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <li className={`turn${turn.failed ? ' failed' : ''}${turn.asked ? ' asked' : ''}${turn.endedAt ? '' : ' live'}`}>
      <details open={open}>
        <summary>
          <span className="turn-name">{label}</span>
          <span className="turn-facts faint">{facts}</span>
          <time className="faint" dateTime={new Date(turn.startedAt).toISOString()}>{new Date(turn.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
        </summary>
        {turn.files.length ? (
          <ul className="turn-files" aria-label="Files written">
            {turn.files.map((f) => <li key={f} className="mono" title={f}>{f.split('/').pop()}</li>)}
          </ul>
        ) : null}
        <ol className="turn-steps">
          {steps.map((e) => (
            <li key={e.id} className={`tl tl-${e.event}`}>
              <span className="tl-kind">{EVENT_LABEL[e.event] ?? e.event}</span>
              <span className="tl-text">{e.tool === CHATTER_TOOL && e.event === 'PreToolUse' ? chatterLine(decodeChatter(e.summary)) : (e.summary ?? e.tool ?? '')}</span>
            </li>
          ))}
        </ol>
      </details>
      {change}
    </li>
  );
}

function PromoteDialog({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<CardType>('task');
  const [name, setName] = useState(title);
  const once = useSingleFlight();
  const submit = (): Promise<void> => once(async () => {
    const card = await attempt(() => call('sessions.promote', { id: sessionId, type, title: name }), (m) => toast(m, 'error'));
    if (card) { toast(`${card.key} created. This session now belongs to it.`); onClose(); openCard(card.key); }
  });
  return (
    <Dialog title="Make this a card" onClose={onClose} footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" onClick={() => submit()} disabled={!name.trim()}>Create card</Button></>}>
      <p className="faint">The session and everything it has done so far moves onto the new card.</p>
      <Field label="Title">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />}</Field>
      <div className="field"><span className="field-label">Type</span><Segmented<CardType> label="Type" value={type} onChange={setType} options={CARD_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} /></div>
    </Dialog>
  );
}


/** The session's title; click to rename it. */
function SessionTitle({ id, title }: { id: string; title: string }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  useEffect(() => { setDraft(title); }, [title]);
  if (!editing) {
    return (
      <h1 id="session-title">
        <button type="button" className="title-button" title="Rename this session" onClick={() => setEditing(true)}>{title}</button>
      </h1>
    );
  }
  const save = (): void => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== title) void attempt(() => call('sessions.rename', { id, title: draft }), (m) => toast(m, 'error'));
    else setDraft(title);
  };
  return (
    <h1 id="session-title">
      <label className="visually-hidden" htmlFor="session-rename">Session title</label>
      <input id="session-rename" className="title-input" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); setDraft(title); setEditing(false); } }} />
    </h1>
  );
}
