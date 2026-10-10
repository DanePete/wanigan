// A session: its terminal is the work, on the canvas, with the composer at its
// foot. The session's bar names it and holds its few tools; its turns and its
// facts (agent, account, model, tokens, limits, card, branch, time) are a right
// panel that closes. Needs-you states (asking permission, out of its limit) are
// said under the bar; an ended session offers to resume where the composer was.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { CARD_TYPES, LIVE_STATES, type Account, type Card, type CardType, type ProjectSummary, type Provider, type Session, type SessionEvent } from '@shared/model';
import { receivesLine } from '@shared/attachments';
import { CHATTER_TOOL, chatterLine, decodeChatter } from '@shared/chatter';
import { groupTurns, turnLength, type Turn } from '@shared/turns';
import type { Checkpoint, SessionCheckpoints } from '@shared/checkpoints';
import type { Shortcut } from '@shared/shortcuts';
import { TurnChange, TurnPanel, UndoDialog } from './TurnChanges';
import { attempt, call, forProject, useQuery } from '../lib/api';
import { useDraft } from '../lib/draft';
import { href, navigate, openCard } from '../lib/router';
import { PROVIDER_LABEL, TYPE_LABEL, ago, duration, plural } from '../lib/format';
import { Icon, type IconName } from '../components/icons';
import {
  Badge, Button, Dialog, EmptyState, Field, IconButton, KeyCaps, ProjectMark, Segmented, StateMark, isMac, tipProps, useSingleFlight, useToast,
} from '../components/ui';
import { Panel, Section } from '../components/Panel';
import { Tabs, TabPanel } from '../components/Tabs';
import { ToolGroup } from '../components/Toolbar';
import { Terminal } from '../components/Terminal';
import { ContinueOn } from '../components/ContinueOn';
import { SessionUsage } from '../components/Tokens';
import { LimitsLeft } from '../components/LimitsLeft';
import { Ask } from '../components/Ask';
import { AttachButton, AttachmentChips, useAttachments, useFileDrop } from '../components/Attachments';
import { LivePane } from '../components/Live';
import { useLiveSplit, useSessionEdits } from '../lib/live';
import { useAppState } from '../lib/settings';
import { liveFor } from '@shared/settings';
import { limitDetail } from '@shared/limits';
import { RUNTIME_LABEL, localModelLabel, parseLocalModel } from '@shared/local-models';

/*
 * The session's own keys, handled here (in the capture phase, so a focused
 * terminal does not take them). shared/shortcuts.ts has no group for a session
 * yet, so these are in the tooltips and aria-keyshortcuts but not on the sheet.
 */
const PANEL_KEYS: Shortcut = { id: null, label: 'Show or hide the session’s turns and details', group: 'Anywhere', keys: ['Mod', 'Shift', 'D'] };
const COMPOSER_KEYS: Shortcut = { id: null, label: 'Message the agent, or go back to its terminal', group: 'Anywhere', keys: ['Mod', 'Shift', 'M'] };

type PanelTab = 'turns' | 'details';
const PANEL_OPEN_KEY = 'wanigan.session.panel';
const PANEL_TAB_KEY = 'wanigan.session.panelTab';

// Per-viewer conveniences: losing them loses nothing that matters.
function readPanelOpen(): boolean {
  try { return localStorage.getItem(PANEL_OPEN_KEY) !== 'closed'; } catch { return true; }
}
function readPanelTab(): PanelTab {
  try { return localStorage.getItem(PANEL_TAB_KEY) === 'details' ? 'details' : 'turns'; } catch { return 'turns'; }
}

const PROVIDER_ICON: Record<Provider, IconName> = { claude: 'claude', codex: 'codex', gemini: 'gemini', shell: 'terminal' };

export function SessionView({ project, sessionId }: { project: ProjectSummary; sessionId: string }) {
  const data = useQuery('sessions.get', { id: sessionId }, ['sessions'], (_e, d) => (d as { sessionId?: string })?.sessionId === sessionId);
  const cards = useQuery('cards.list', { projectId: project.id }, ['board'], (_e, d) => (d as { projectId?: string })?.projectId === project.id);
  const toast = useToast();
  const main = useRef<HTMLDivElement>(null);
  const focusTerminal = useRef<(() => void) | null>(null);
  const [panelOpen, setPanelOpenState] = useState(readPanelOpen);
  const setPanelOpen = (open: boolean): void => {
    setPanelOpenState(open);
    try { localStorage.setItem(PANEL_OPEN_KEY, open ? 'open' : 'closed'); } catch { /* remembered for this visit only */ }
  };
  const [tab, setTabState] = useState<PanelTab>(readPanelTab);
  const setTab = (next: PanelTab): void => {
    setTabState(next);
    try { localStorage.setItem(PANEL_TAB_KEY, next); } catch { /* remembered for this visit only */ }
  };
  const [promoting, setPromoting] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const session = data.data?.session;
  const live = !!session && LIVE_STATES.has(session.state);
  const card = session?.cardId ? cards.data?.find((c) => c.id === session.cardId) : undefined;
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const account = session?.accountId ? accounts.data?.find((a) => a.id === session.accountId) : undefined;
  // What git recorded per turn. Agents only: a shell has no turns.
  const hasTurns = !!session && session.provider !== 'shell';
  const checkpoints = useQuery('sessions.checkpoints', hasTurns ? { id: sessionId } : null, ['sessions'],
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
  const shownTab: PanelTab = hasTurns ? tab : 'details';

  // Opening a session is seeing it: it settles "finished a turn" and "failed".
  useEffect(() => {
    if (session && (session.state === 'waiting' || session.state === 'failed' || session.state === 'interrupted')) {
      void call('sessions.seen', { id: session.id }).catch(() => {});
    }
  }, [session?.id, session?.state, session?.lastEventAt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setConfirmStop(false); setTurnOpen(null); setUndoing(false); }, [sessionId]);

  // ⌘⇧D shows or hides the panel; ⌘⇧M moves between the composer and the terminal (whose Tab is the program's).
  const keyState = useRef({ panelOpen, live });
  keyState.current = { panelOpen, live };
  useEffect(() => {
    const mac = isMac();
    const onKey = (e: KeyboardEvent): void => {
      if (!(mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || !e.shiftKey || e.altKey) return;
      if (e.code !== 'KeyD' && e.code !== 'KeyM') return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'KeyD') { setPanelOpen(!keyState.current.panelOpen); return; }
      if (!keyState.current.live) return;
      const box = document.getElementById('composer');
      if (box && document.activeElement !== box) box.focus();
      else focusTerminal.current?.();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (data.error) return <div className="view session"><EmptyState title="This session could not be read" icon="alert">{data.error.message}</EmptyState></div>;
  if (!session) return <div className="view session"><div className="session-opening" role="status" aria-label="Opening the session" /></div>;

  const local = parseLocalModel(session.model);
  const agent = PROVIDER_LABEL[session.provider];

  return (
    <section className="view session" aria-labelledby="session-title">
      <header className="topbar session-bar">
        <div className="topbar-title">
          <a className="btn btn-quiet btn-icon btn-icon-s" href={href({ name: 'project', projectKey: project.key, view: 'sessions' })}
            aria-label={`Back to ${project.name} sessions`} {...tipProps(`Back to ${project.name} sessions`)}>
            <Icon name="back" size={14} />
          </a>
          <ProjectMark projectKey={project.key} size="s" />
          <SessionTitle id={session.id} title={session.title} />
          <StateMark state={session.state} />
          {local ? (
            <span className="remote-mark" {...tipProps(`${localModelLabel(session.model) ?? session.model} runs on this computer through ${RUNTIME_LABEL[local.runtime]}`)}>
              <Badge><Icon name="local" size={12} /><span className="remote-mark-label">On this computer</span></Badge>
            </span>
          ) : null}
          {session.remote ? (
            <span className="remote-mark" {...tipProps('Started with Claude Code’s Remote Control: Anthropic relays it to claude.ai and the Claude app')}>
              <Badge><Icon name="remote" size={12} /><span className="remote-mark-label">Remote Control</span></Badge>
            </span>
          ) : null}
        </div>
        <div className="topbar-tools">
          {siteUrl && !showLive && edits.paths ? (
            <Button size="s" tone="quiet" icon="live" className="live-chip" onClick={seeIt}
              {...tipProps(`This session changed ${edits.paths.map((p) => p.split('/').pop()).join(', ')}: open the site beside the terminal, with what it made outlined`)}>
              {edits.paths[0]?.split('/').pop()} changed · See it
            </Button>
          ) : null}
          {!card ? <Button size="s" icon="promote" onClick={() => setPromoting(true)}>Make this a card</Button> : null}
          {live ? (
            confirmStop ? (
              <span className="session-stop-confirm" role="group" aria-label="Stop this session?">
                <Button size="s" tone="danger" icon="stop" onClick={() => attempt(() => call('sessions.stop', { id: session.id }), (m) => toast(m, 'error')).then(() => setConfirmStop(false))}>Stop it</Button>
                <Button size="s" tone="quiet" onClick={() => setConfirmStop(false)}>Keep running</Button>
              </span>
            ) : <Button size="s" tone="quiet" icon="stop" onClick={() => setConfirmStop(true)}>Stop</Button>
          ) : null}
          <ToolGroup label="Show beside the terminal">
            {siteUrl ? (
              <IconButton icon="live" label={showLive ? 'Hide the site' : 'Show the site beside the terminal'} pressed={showLive}
                onClick={() => { if (showLive) setSplit(false); else seeIt(); }} />
            ) : null}
            <IconButton icon="sidebar" label={panelOpen ? 'Hide the turns and details' : 'Show the turns and details'} pressed={panelOpen}
              keys={PANEL_KEYS} tipSide="bottom" onClick={() => setPanelOpen(!panelOpen)} />
          </ToolGroup>
        </div>
      </header>

      {session.state === 'permission' ? (
        <div className="banner banner-amber session-banner banner-asks" role="status">
          <div className="banner-head">
            <Icon name="alert" size={15} />
            <p className="banner-text">{session.activity ?? 'The agent is asking for permission.'} Answer it in the terminal.</p>
            <Button size="s" tone="attention" onClick={() => focusTerminal.current?.()}>Answer in the terminal</Button>
          </div>
          {session.asks?.length ? <div className="need-asks">{session.asks.map((ask, i) => <Ask key={`${i}-${ask.tool}`} ask={ask} />)}</div> : null}
        </div>
      ) : null}
      {session.state === 'limited' ? (
        <div className="banner banner-amber session-banner banner-limit" role="status">
          <Icon name="alert" size={15} />
          <span className="banner-text">
            {limitDetail(session.limit?.resetsAt ?? null, Date.now(), account?.label, session.provider)}
            {session.activity ? <span className="faint"> {session.provider === 'claude' ? 'Claude' : agent} said: “{session.activity}”</span> : null}
            {session.provider === 'gemini' ? <span className="faint"> Gemini asks in its terminal whether to keep trying, switch model or stop.</span> : null}
          </span>
          {session.provider === 'claude' || session.provider === 'codex'
            ? <span className="banner-actions"><ContinueOn sessionId={session.id} accountId={session.accountId} projectKey={project.key} provider={session.provider} /></span> : null}
        </div>
      ) : null}

      <div className="session-body">
        <div className="session-stage">
          <div className="session-main" ref={main} inert={turnOpen ? true : undefined}>
            <Terminal sessionId={session.id} live={live} focusRef={focusTerminal} />
            {live ? <Composer sessionId={session.id} provider={session.provider} state={session.state} zone={main} />
              : <Ended session={session} pausedAt={project.pausedAt} projectKey={project.key} />}
          </div>
          {turnOpen ? (
            <TurnPanel session={session} projectId={project.id} checkpoint={turnOpen.checkpoint} label={turnOpen.label}
              last={last && last.eventId === turnOpen.checkpoint.eventId ? last : null}
              onUndo={() => setUndoing(true)} onClose={() => setTurnOpen(null)} />
          ) : null}
        </div>
        {showLive ? (
          <div className="session-live">
            <LivePane project={project} follow={session.id} card={session.cardId ? { id: session.cardId, key: session.cardKey ?? 'the card' } : null} compact outlineFirst={outlineFirst} />
          </div>
        ) : null}
        <Panel side="right" open={panelOpen} onClose={() => setPanelOpen(false)} closeKeys={PANEL_KEYS} resizable sizeKey="session-panel" minSize={260} maxSize={520}
          label="The session’s turns and details" className="session-panel"
          title={<span className="session-agent"><Icon name={PROVIDER_ICON[session.provider]} size={16} />{agent}{account ? <span className="faint">as {account.label}</span> : null}</span>}
          tabs={hasTurns ? (
            <Tabs id="session-panel" label="What the panel shows" value={shownTab} onChange={setTab}
              tabs={[{ value: 'turns', label: 'Turns', count: turnCount(data.data?.events ?? []) }, { value: 'details', label: 'Details' }]} />
          ) : undefined}>
          {shownTab === 'turns' ? (
            <TabPanel tabs="session-panel" value="turns" className="timeline">
              <Timeline events={data.data?.events ?? []} checkpoints={checkpoints.error ? undefined : checkpoints.data}
                error={checkpoints.error} onRetry={checkpoints.reload}
                openId={turnOpen?.checkpoint.id ?? null} onOpen={(checkpoint, label) => setTurnOpen({ checkpoint, label })} onUndo={() => setUndoing(true)} />
            </TabPanel>
          ) : hasTurns ? (
            <TabPanel tabs="session-panel" value="details" className="session-facts">
              <Details session={session} account={account} card={card} live={live} onPromote={() => setPromoting(true)} />
            </TabPanel>
          ) : (
            <div className="session-facts">
              <Details session={session} account={account} card={card} live={live} onPromote={() => setPromoting(true)} />
            </div>
          )}
        </Panel>
      </div>

      {promoting ? <PromoteDialog sessionId={session.id} title={session.title} onClose={() => setPromoting(false)} /> : null}
      {undoing && last ? <UndoDialog session={session} last={last} onClose={() => setUndoing(false)} /> : null}
    </section>
  );
}

/** How many turns the agent has taken (the start is not one). */
function turnCount(events: SessionEvent[]): number | null {
  const n = groupTurns(events).filter((t) => t.n > 0).length;
  return n || null;
}

/* ── the composer ─────────────────────────────────────────────────────────── */

/**
 * Message the agent. Images and files pasted or dropped on the terminal or
 * here, or picked with the paperclip, wait as chips and go with the message.
 * Enter sends, Shift+Enter starts a new line; the box grows to a few lines.
 */
function Composer({ sessionId, provider, state, zone }: { sessionId: string; provider: Provider; state: string; zone: RefObject<HTMLDivElement | null> }) {
  const { text, setText, clear } = useDraft();
  const toast = useToast();
  const input = useRef<HTMLTextAreaElement>(null);
  const takesFiles = provider !== 'shell';
  const attach = useAttachments(takesFiles ? { session: sessionId } : null);
  useFileDrop(zone, (files) => { if (takesFiles) void attach.add(files); else toast('A shell takes no attachments.', 'error'); });
  const waits = provider === 'claude' && state !== 'waiting';
  const ids = attach.files.map((f) => f.id);
  const once = useSingleFlight();

  // The box grows with what is typed, up to its stylesheet's most.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    const most = parseFloat(getComputedStyle(el).maxHeight);
    el.style.height = `${Number.isFinite(most) ? Math.min(el.scrollHeight, most) : el.scrollHeight}px`;
  }, [text]);

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
  const agent = PROVIDER_LABEL[provider];
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <div className="composer-box">
        {attach.files.length || attach.adding ? (
          <div className="composer-files">
            <AttachmentChips files={attach.files} adding={attach.adding} onRemove={attach.remove} />
            <p className="attach-note" {...(provider === 'claude'
              ? tipProps('Claude Code reads a pasted image path itself, with no permission prompt, unless your settings deny reading there; then it gets the path as text.')
              : {})}>{receivesLine(provider)}</p>
          </div>
        ) : null}
        <label className="visually-hidden" htmlFor="composer">{provider === 'shell' ? 'Send to the shell' : `Message ${agent}`}</label>
        <textarea
          ref={input}
          id="composer"
          rows={1}
          value={text}
          aria-keyshortcuts={isMac() ? 'Meta+Shift+M' : 'Control+Shift+M'}
          onChange={(e) => setText(e.target.value)}
          placeholder={provider === 'shell' ? 'Send to the shell' : waits ? `Message ${agent}: it goes when the agent is idle` : `Message ${agent}`}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
        />
        <div className="composer-tools">
          {takesFiles ? <AttachButton onPick={attach.pick} /> : null}
          {/* Voice input (its own branch) is merged here, beside the paperclip: an empty slot until then. */}
          <span className="composer-slot composer-voice" data-slot="voice" />
          <span className="composer-hint" aria-hidden="true">
            <KeyCaps keys={['Enter']} /> sends <span className="composer-hint-sep">·</span> <KeyCaps keys={['Shift', 'Enter']} /> new line
            <span className="composer-hint-sep">·</span> <KeyCaps shortcut={COMPOSER_KEYS} /> terminal
          </span>
          <Button tone="primary" size="s" type="submit" icon="send" disabled={(!text.trim() && !ids.length) || attach.adding > 0}>{waits ? 'Queue' : 'Send'}</Button>
        </div>
      </div>
    </form>
  );
}

/** Where the composer was, once the session has ended: how it ended, and the way back in. */
function Ended({ session, pausedAt, projectKey }: { session: Session; pausedAt: number | null; projectKey: string }) {
  const toast = useToast();
  const failed = session.state !== 'ended';
  const said = `${session.activity ?? (failed ? 'This session stopped' : 'This session has ended')}${session.exitCode !== null ? ` (exit code ${session.exitCode})` : ''}.`;
  return (
    <div className={`session-ended${failed ? ' failed' : ''}`} role="status">
      <Icon name={failed ? 'alert' : 'check'} size={15} className="session-ended-icon" />
      <span className="session-ended-text">{said} <span className="faint">Ended {ago(session.endedAt)}.</span></span>
      {session.provider !== 'shell' && session.conversationId ? (
        <Button size="s" tone="primary" icon="resume" disabled={!!pausedAt}
          {...tipProps(pausedAt ? 'Resume the project first' : 'Continue this conversation in a new session, with the same account')}
          onClick={function resume(): Promise<void> {
            return attempt(() => call('sessions.resume', { id: session.id }), (m) => toast(m, 'error', { action: { label: 'Retry', run: () => void resume() } }))
              .then((s) => { if (s) navigate({ name: 'session', projectKey, sessionId: s.id }); });
          }}>
          Resume conversation
        </Button>
      ) : null}
    </div>
  );
}

/* ── the panel: details ───────────────────────────────────────────────────── */

function Details({ session, account, card, live, onPromote }: {
  session: Session; account: Account | undefined; card: Card | undefined; live: boolean; onPromote: () => void;
}) {
  const local = parseLocalModel(session.model);
  const model = [localModelLabel(session.model) ?? session.model, session.effort].filter(Boolean).join(' · ');
  const branch = card?.worktree && session.cwd && (session.cwd === card.worktree.path || session.cwd.startsWith(`${card.worktree.path}/`)) ? card.worktree.branch : null;
  const started = new Date(session.startedAt);
  return (
    <>
      <Section title="Agent">
        <dl className="facts">
          <div><dt>Agent</dt><dd>{PROVIDER_LABEL[session.provider]}</dd></div>
          {session.provider !== 'shell' ? <div><dt>Account</dt><dd>{account?.label ?? (session.accountId ? 'Not found' : 'Its own sign-in')}</dd></div> : null}
          {session.provider !== 'shell' ? <div><dt>Model</dt><dd className={model ? 'mono' : 'faint'}>{model || 'The account’s default'}</dd></div> : null}
        </dl>
        {local ? (
          <p className="facts-note"><span className="remote-mark"><Badge><Icon name="local" size={12} />On this computer</Badge></span>{' '}
            The model runs here through {RUNTIME_LABEL[local.runtime]}: prompts and code go to it, not to a model provider, and no plan’s limits apply.</p>
        ) : null}
        {session.remote ? (
          <p className="facts-note"><span className="remote-mark"><Badge><Icon name="remote" size={12} />Remote Control</Badge></span>{' '}
            Started with Claude Code’s Remote Control, as you asked. If your account is eligible, Anthropic relays this session to claude.ai and the Claude app; the terminal shows whether it connected.</p>
        ) : null}
      </Section>
      {session.provider !== 'shell' ? <Section title="Tokens"><SessionUsage sessionId={session.id} /></Section> : null}
      {account && !local ? (
        <Section title={`What ${account.label} has left`}>
          <LimitsLeft usage={account.usage} full />
        </Section>
      ) : null}
      <Section title="Work">
        <dl className="facts">
          <div>
            <dt>Card</dt>
            <dd>{card ? <button type="button" className="linkish mono" onClick={() => openCard(card.key)} {...tipProps(`Open ${card.key}: ${card.title}`)}>{card.key}</button>
              : <>One-off <button type="button" className="linkish" onClick={onPromote}>Make it a card</button></>}</dd>
          </div>
          {branch ? <div><dt>Branch</dt><dd className="mono">{branch}</dd></div> : null}
          {session.cwd ? <div><dt>Folder</dt><dd className="mono facts-path" {...tipProps(session.cwd)}>{session.cwd.split('/').slice(-2).join('/')}</dd></div> : null}
        </dl>
      </Section>
      <Section title="Time">
        <dl className="facts">
          <div><dt>Started</dt><dd><time dateTime={started.toISOString()}>{started.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></dd></div>
          {live ? <div><dt>Running</dt><dd>{duration(session.startedAt)}</dd></div>
            : <div><dt>Ended</dt><dd>{ago(session.endedAt)}{session.endedAt ? <span className="faint"> · ran {duration(session.startedAt, session.endedAt)}</span> : null}</dd></div>}
          {session.exitCode !== null ? <div><dt>Exit code</dt><dd className="mono">{session.exitCode}</dd></div> : null}
        </dl>
      </Section>
    </>
  );
}

/* ── the panel: turns ─────────────────────────────────────────────────────── */

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
    <>
      {error ? (
        <div className="timeline-note timeline-error" role="alert">
          <p className="error-text">{error.message}</p>
          <Button size="s" icon="refresh" onClick={onRetry}>Retry</Button>
        </div>
      ) : null}
      {baseline ? <p className="timeline-note faint">Turns are not checkpointed here: {baseline}.</p> : null}
      {turns.length ? (
        <ol className="turns" aria-label="What the agent did, newest first">
          {turns.map((t, i) => {
            const checkpoint = t.events.map((e) => byEvent.get(e.id)).filter(Boolean).at(-1) ?? null;
            const label = checkpoint ? (checkpoint.turn ? `Turn ${checkpoint.turn}` : 'Start') : t.n ? `Turn ${t.n}` : 'Start';
            const lastTurn = checkpoints?.last && t.events.some((e) => e.id === checkpoints.last?.eventId) ? checkpoints.last : null;
            return (
              <TurnRow key={t.events[0]?.id ?? i} turn={t} open={i === 0} label={label}
                change={checkpoint ? <TurnChange checkpoint={checkpoint} baseline={baseline} last={lastTurn} open={checkpoint.id === openId} onOpen={() => onOpen(checkpoint, label)} onUndo={onUndo} /> : null} />
            );
          })}
        </ol>
      ) : (
        <EmptyState title="No turns yet" icon="activity">The agent’s hooks report each step here as it works. An agent without hooks has none.</EmptyState>
      )}
    </>
  );
}

/** One turn: what it took, what it touched, then each step. The newest is open. What git saw it change sits under it. */
function TurnRow({ turn, open, label, change }: { turn: Turn; open: boolean; label: string; change: ReactNode }) {
  const steps = turn.events.filter((e) => e.event !== 'PostToolUse' && e.event !== 'UserPromptSubmit');
  const facts = [
    turn.n === 0 ? null : turn.endedAt ? turnLength(turn.startedAt, turn.endedAt) : 'going',
    turn.tools ? plural(turn.tools, 'tool') : null,
    // Git's count, under the turn, replaces the edit tools' own.
    turn.files.length && !change ? plural(turn.files.length, 'file') : null,
  ].filter(Boolean).join(' · ');
  return (
    <li className={`turn${turn.failed ? ' failed' : ''}${turn.asked ? ' asked' : ''}${turn.endedAt ? '' : ' turn-going'}`}>
      <details open={open}>
        <summary>
          <Icon name="chevron" size={12} className="turn-twist" />
          <span className="turn-name">{label}</span>
          <span className="turn-facts faint">{facts}</span>
          <time className="faint" dateTime={new Date(turn.startedAt).toISOString()}>{new Date(turn.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
        </summary>
        {turn.files.length ? (
          <ul className="turn-files" aria-label="Files written">
            {turn.files.map((f) => <li key={f} className="mono" {...tipProps(f)}>{f.split('/').pop()}</li>)}
          </ul>
        ) : null}
        {steps.length ? (
          <ol className="turn-steps">
            {steps.map((e) => (
              <li key={e.id} className={`tl tl-${e.event}`}>
                <span className="tl-kind">{EVENT_LABEL[e.event] ?? e.event}</span>
                <span className="tl-text">{e.tool === CHATTER_TOOL && e.event === 'PreToolUse' ? chatterLine(decodeChatter(e.summary)) : (e.summary ?? e.tool ?? '')}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </details>
      {change}
    </li>
  );
}

/* ── dialogs and the title ────────────────────────────────────────────────── */

function PromoteDialog({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<CardType>('task');
  const [name, setName] = useState(title);
  const once = useSingleFlight();
  const submit = (): Promise<void> => once(async () => {
    const card = await attempt(() => call('sessions.promote', { id: sessionId, type, title: name }), (m) => toast(m, 'error'));
    if (card) { toast(`${card.key} created. This session now belongs to it.`, 'done'); onClose(); openCard(card.key); }
  });
  return (
    <Dialog title="Make this a card" onClose={onClose} footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" onClick={() => submit()} disabled={!name.trim()}>Create card</Button></>}>
      <Field label="Title" hint="The session, and everything it has done so far, moves onto the new card.">{(id) => (
        <input id={id} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
      )}</Field>
      <div className="field"><span className="field-label">Type</span><Segmented<CardType> label="Type" value={type} onChange={setType} options={CARD_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} /></div>
    </Dialog>
  );
}

/** The session's title; click (or Enter) to rename it. */
function SessionTitle({ id, title }: { id: string; title: string }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  useEffect(() => { setDraft(title); }, [title]);
  if (!editing) {
    return (
      <h1 id="session-title" className="session-title">
        <button type="button" className="title-button" {...tipProps('Rename this session')} onClick={() => setEditing(true)}>{title}</button>
      </h1>
    );
  }
  const save = (): void => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== title) void attempt(() => call('sessions.rename', { id, title: draft }), (m) => toast(m, 'error'));
    else setDraft(title);
  };
  return (
    <h1 id="session-title" className="session-title">
      <label className="visually-hidden" htmlFor="session-rename">Session title</label>
      <input id="session-rename" className="title-input" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); setDraft(title); setEditing(false); } }} />
    </h1>
  );
}
