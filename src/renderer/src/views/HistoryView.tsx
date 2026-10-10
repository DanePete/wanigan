// A project's History: every earlier Claude Code and Codex conversation in its
// folder, wherever it ran (a terminal, VS Code or here), to read or
// to pick up again as a live session.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Account, HistoryItem, HistoryTurn, ProjectSummary } from '@shared/model';
import type { Shortcut } from '@shared/shortcuts';
import { attempt, call, useQuery } from '../lib/api';
import { href, navigate } from '../lib/router';
import { PROVIDER_LABEL, plural } from '../lib/format';
import { Icon } from '../components/icons';
import { Badge, Button, Dialog, EmptyState, NotAnswering, tipProps, useToast } from '../components/ui';
import { Panel, Section } from '../components/Panel';
import { Toolbar } from '../components/Toolbar';
import { useHow } from '../lib/how';
import { HowArrow, HowBox, HowButton, HowDialog, HowLane, HowNote, howNum } from '../components/How';

const GROUPS = ['Today', 'Yesterday', 'This week', 'Earlier'] as const;
type Group = (typeof GROUPS)[number];
const CLOSE_KEYS: Shortcut = { id: null, label: 'Close the conversation', group: 'In dialogs and lists', keys: ['Esc'] };

export function HistoryView({ project }: { project: ProjectSummary }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const history = useQuery('history.list', { projectId: project.id, query: search }, ['projects']);
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const toast = useToast();
  const [reading, setReading] = useState<{ id: string; focus: boolean } | null>(null);
  const [choosing, setChoosing] = useState<HistoryItem | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const how = useHow('history');

  const items = history.data ?? [];
  const read = items.find((i) => i.id === reading?.id) ?? null;
  const waiting = query.trim() !== search || history.loading;
  const count = search ? plural(items.length, 'match', 'matches') : plural(items.length, 'conversation');
  const groups = useMemo(() => {
    const now = new Date();
    const by = new Map<Group, HistoryItem[]>();
    for (const item of items) {
      const g = groupOf(item.updatedAt, now);
      by.set(g, [...(by.get(g) ?? []), item]);
    }
    return GROUPS.filter((g) => by.has(g)).map((g) => ({ group: g, items: by.get(g) as HistoryItem[] }));
  }, [items]);
  // An account is named on a row only when there is more than one to tell apart.
  const several = useMemo(() => {
    const n = { claude: 0, codex: 0 };
    for (const a of accounts.data ?? []) n[a.provider]++;
    return { claude: n.claude > 1, codex: n.codex > 1 };
  }, [accounts.data]);

  const start = async (item: HistoryItem, accountId?: string): Promise<void> => {
    const session = await attempt(() => call('history.resume', { id: item.id, ...(accountId ? { accountId } : {}) }), (m) => toast(m, 'error'));
    if (session) navigate({ name: 'session', projectKey: project.key, sessionId: session.id });
  };
  const resume = (item: HistoryItem): Promise<void> | undefined => {
    if (item.live && item.sessionId) { navigate({ name: 'session', projectKey: project.key, sessionId: item.sessionId }); return; }
    // A Claude conversation can continue as the account this project uses, as a fork. Ask which.
    const usual = project.accounts[item.provider] ?? accounts.data?.find((a) => a.provider === item.provider && a.isDefault)?.id;
    if (item.provider === 'claude' && usual && usual !== item.accountId) { setChoosing(item); return; }
    return start(item);
  };

  /**
   * Closing the reader while it has the keys gives them back to its row, found by its id (the list may have been
   * drawn again since it opened); closed from the list, the keys stay where they are.
   */
  const closeReader = (id: string): void => {
    const inside = !!document.activeElement?.closest('.reader') || document.activeElement === document.body;
    if (inside) list.current?.querySelector<HTMLButtonElement>(`.hrow-main[data-id="${CSS.escape(id)}"]`)?.focus();
    setReading(null);
  };

  /** Up and Down walk the rows; with a conversation open, it follows without taking the keys. */
  const walk = (e: KeyboardEvent<HTMLButtonElement>, id: string): void => {
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('.hrow-main') ?? [])];
    const at = rows.indexOf(e.currentTarget);
    let next: number;
    if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, at + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    else return;
    e.preventDefault();
    const to = rows[next];
    if (!to) return;
    to.focus();
    to.scrollIntoView({ block: 'nearest' });
    if (reading && to.dataset.id && to.dataset.id !== id) setReading({ id: to.dataset.id, focus: false });
  };

  return (
    <div className="history-view">
      <div className="history-main">
        <Toolbar label="History" className="history-bar">
          <label className="search-field" data-tour="history-search">
            <Icon name="search" size={14} />
            <span className="visually-hidden">Search conversations</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles, prompts and branches"
              onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }} />
          </label>
          <span className="toolbar-count" aria-live="polite">
            {waiting ? 'Searching…' : history.error ? 'Could not read history' : `${items.length === 500 ? 'Newest ' : ''}${count}`}
          </span>
          <span className="toolbar-gap" />
          <HowButton onClick={how.show} />
        </Toolbar>
        <div className="history-list" ref={list} data-tour="history-list">
          {history.error ? <NotAnswering error={history.error} onRetry={history.reload} title="History could not be loaded" />
            : waiting && !items.length ? <div className="history-loading" role="status" aria-label="Reading this folder’s conversations" />
              : groups.map(({ group, items: rows }) => (
                <Section key={group} title={group} className="history-group">
                  <ol className="hrows">
                    {rows.map((item) => (
                      <HistoryRow key={item.id} item={item} group={group} showAccount={several[item.provider]} active={reading?.id === item.id}
                        pausedAt={project.pausedAt} onRead={() => setReading({ id: item.id, focus: true })} onResume={() => resume(item)}
                        onWalk={(e) => walk(e, item.id)} />
                    ))}
                  </ol>
                </Section>
              ))}
          {!history.error && !waiting && !items.length ? (
            search ? <EmptyState title={`Nothing matches “${query}”`} icon="search">Search looks in titles, first prompts and branches.</EmptyState>
              : <EmptyState title="No conversations yet" icon="history">Every Claude Code and Codex conversation in this folder appears here, wherever it ran: here, VS Code or another terminal.</EmptyState>
          ) : null}
        </div>
      </div>
      {read ? (
        <Reader key={read.id} item={read} focus={reading?.focus ?? false} projectKey={project.key} pausedAt={project.pausedAt}
          onClose={() => closeReader(read.id)} onResume={() => resume(read)} />
      ) : null}
      {how.open ? (
        <HistoryHow count={history.data && !search ? items.length : null} live={history.data ? items.filter((i) => i.live).length : null}
          elsewhere={history.data ? items.filter((i) => !!i.via).length : null} paused={!!project.pausedAt} onClose={how.hide} />
      ) : null}
      {choosing ? (
        <ChooseAccount item={choosing} accounts={accounts.data ?? []} accountsError={accounts.error} preferred={project.accounts.claude ?? null} onClose={() => setChoosing(null)}
          onStart={(accountId) => { setChoosing(null); void start(choosing, accountId); }} />
      ) : null}
    </div>
  );
}

function HistoryRow({ item, group, showAccount, active, pausedAt, onRead, onResume, onWalk }: {
  item: HistoryItem; group: Group; showAccount: boolean; active: boolean; pausedAt: number | null; onRead: () => void; onResume: () => void;
  onWalk: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { title, snippet } = heading(item);
  return (
    <li className={`hrow${active ? ' active' : ''}`}>
      {/* The whole row reads the conversation; Resume beside it is the one action. */}
      <button type="button" className="hrow-main" data-id={item.id} data-tour="history-row" aria-current={active ? 'true' : undefined} onClick={onRead} onKeyDown={onWalk}>
        <ProviderMark provider={item.provider} />
        <span className="hrow-text">
          <span className="hrow-title">{title}</span>
          {snippet ? <span className="hrow-prompt">{snippet}</span> : null}
          <span className="hrow-meta">
            <time dateTime={new Date(item.updatedAt).toISOString()}>{when(item.updatedAt, group)}</time>
            {item.branch ? <span className="mono hrow-branch">{item.branch}</span> : null}
            {item.cardKey ? <span className="mono">{item.cardKey}</span> : null}
            {showAccount ? <span>{item.accountLabel}</span> : null}
            <Tags item={item} />
          </span>
        </span>
      </button>
      <div className="hrow-actions">
        <ResumeButton item={item} pausedAt={pausedAt} onResume={onResume} label={title} tone="quiet" />
      </div>
    </li>
  );
}

function ResumeButton({ item, pausedAt, onResume, label, tone = 'plain' }: {
  item: HistoryItem; pausedAt: number | null; onResume: () => void; label: string; tone?: 'plain' | 'quiet' | 'primary';
}) {
  if (item.live && item.sessionId) {
    return <Button size="s" tone={tone} icon="terminal" onClick={onResume} aria-label={`Open the live session for ${label}`} {...tipProps('Open the live session')}>Open</Button>;
  }
  return (
    <Button size="s" tone={tone} icon="resume" onClick={onResume} disabled={!!pausedAt} aria-label={`Resume ${label}`} data-tour="history-resume"
      {...tipProps(pausedAt ? 'Paused: resume the project to start sessions' : 'Continue this conversation in a new session. It re-sends the conversation, which uses part of the account’s limits.')}>
      Resume
    </Button>
  );
}

function Tags({ item }: { item: HistoryItem }) {
  return (
    <>
      {item.live ? <Badge tone="water">Live</Badge> : null}
      {item.via ? <Badge>{item.via}</Badge> : null}
    </>
  );
}

function ProviderMark({ provider }: { provider: HistoryItem['provider'] }) {
  return (
    <span className={`hmark hmark-${provider}`}>
      <Icon name={provider} size={15} />
      <span className="visually-hidden">{PROVIDER_LABEL[provider]}</span>
    </span>
  );
}

/** How History works, as a picture: where the conversations come from and what resuming does. Every sentence is a rule the core enforces. */
function HistoryHow({ count, live, elsewhere, paused, onClose }: {
  count: number | null; live: number | null; elsewhere: number | null; paused: boolean; onClose: () => void;
}) {
  return (
    <HowDialog place="history" title="How History works" onClose={onClose}
      intro={<><strong>Every Claude Code and Codex conversation in this folder, wherever it ran.</strong> Read them here, and carry any of them on as a live session.</>}
      side={(
        <>
          <HowNote title="What resuming costs" tone="needs">
            <ul>
              <li>The whole conversation is sent to the model again, which uses part of that account’s limits.</li>
              <li>Nothing is sent until you choose Resume.</li>
            </ul>
          </HowNote>
          <HowNote title="Reading the picture" tone="quiet">
            <ul>
              <li>Numbers are this folder’s. A missing number means its source has not answered.</li>
            </ul>
          </HowNote>
        </>
      )}>
      <HowLane n={1} title="Where they come from" actor="agents">
        <HowBox actor="agents" title="The agents’ own records" num={howNum(count, 'conversation', 'conversations')}>
          Claude Code and Codex keep each conversation on disk. Wanigan reads them from there, never copies them, and lists those that ran in this project’s folder or one of its cards’ worktrees.
        </HowBox>
        <HowArrow />
        <HowBox actor="agents" title="Wherever they ran" num={elsewhere ? howNum(elsewhere, 'not from a terminal', 'not from a terminal') : null}>
          Here, in another terminal, in VS Code or the desktop app: one that did not run in a terminal says how it ran.
        </HowBox>
        <HowArrow />
        <HowBox actor="you" title="Search">
          Titles, first prompts and branches. The list shows the newest 500; a search looks past them.
        </HowBox>
      </HowLane>
      <HowLane n={2} title="Reading" actor="you">
        <HowBox actor="you" title="The reader">
          Your prompts, the agent’s replies and a line for each tool it used (never what the tool returned), newest at the bottom. A long one shows its most recent part, and says so.
        </HowBox>
      </HowLane>
      <HowLane n={3} title="Resuming" actor="you">
        <HowBox actor="you" title="Resume" num={paused ? 'paused: resume the project first' : null}>
          Carries the conversation on in a new live session here, as the account it lives in.
        </HowBox>
        <HowArrow />
        <HowBox actor="you" title="As another account">
          A Claude conversation can continue as another of your accounts instead: a copy with a new id, kept there; the original stays as it was.
        </HowBox>
        <HowArrow />
        <HowBox actor="agents" title="Still running" num={howNum(live, 'live now', 'live now')}>
          A conversation whose session is running here now just opens that session.
        </HowBox>
      </HowLane>
    </HowDialog>
  );
}

/* ── reader ───────────────────────────────────────────────────────────── */

function Reader({ item, focus, projectKey, pausedAt, onClose, onResume }: {
  item: HistoryItem; focus: boolean; projectKey: string; pausedAt: number | null; onClose: () => void; onResume: () => void;
}) {
  const transcript = useQuery('history.read', { id: item.id }, []);
  const top = useRef<HTMLHeadingElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const { title } = heading(item);
  const close = useRef(onClose);
  close.current = onClose;

  // Opened by choosing it, focus comes here; HistoryView gives it back to the row when it closes.
  useLayoutEffect(() => {
    if (focus) top.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Escape closes it, unless a dialog over it has the keys.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[aria-modal="true"]')) close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The newest turn is at the bottom, and that is where reading starts.
  useEffect(() => {
    const body = end.current?.closest('.panel-body');
    if (transcript.data && body) body.scrollTop = body.scrollHeight;
  }, [transcript.data]);

  const agent = PROVIDER_LABEL[item.provider];
  return (
    <Panel side="right" className="reader" label={`Conversation: ${title}`} onClose={onClose} closeKeys={CLOSE_KEYS}
      resizable sizeKey="history-reader" size={480} minSize={340} maxSize={820}
      title={<span className="reader-agent"><ProviderMark provider={item.provider} />{agent}<span className="faint">as {item.accountLabel}</span></span>}>
      <header className="reader-head">
        <h2 className="reader-title" ref={top} tabIndex={-1}>{title}</h2>
        <p className="reader-meta">
          {item.branch ? <span className="mono">{item.branch}</span> : null}
          {item.startedAt && fullDate(item.startedAt) !== fullDate(item.updatedAt) ? <span>started {fullDate(item.startedAt)}</span> : null}
          <time dateTime={new Date(item.updatedAt).toISOString()}>{fullDate(item.updatedAt)}, {new Date(item.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
          <Tags item={item} />
        </p>
        {item.description ? <p className="reader-description">{item.description}</p> : null}
        <div className="reader-actions">
          <ResumeButton item={item} pausedAt={pausedAt} onResume={onResume} label={title} tone="primary" />
          {item.sessionId && !item.live ? <a className="reader-link" href={href({ name: 'session', projectKey, sessionId: item.sessionId })}>Its last session here</a> : null}
        </div>
      </header>
      <div className="reader-body">
        {transcript.error ? <p className="error-text" role="alert">{transcript.error.message}</p>
          : !transcript.data ? <p className="faint" role="status">Reading the conversation…</p>
            : (
              <>
                {transcript.data.truncated ? <p className="reader-note">Earlier turns are left out. This is the most recent part of the conversation.</p> : null}
                {transcript.data.turns.length ? <Messages turns={transcript.data.turns} agent={agent} cwd={item.cwd} />
                  : <p className="faint">This conversation has no text to show.</p>}
              </>
            )}
        <div ref={end} />
      </div>
    </Panel>
  );
}

function Messages({ turns, agent, cwd }: { turns: HistoryTurn[]; agent: string; cwd: string | null }) {
  return (
    <ol className="msgs">
      {turns.map((turn, i) => {
        const speaker = turn.role === 'user' ? 'You' : agent;
        const previous = turns[i - 1];
        const named = turn.role !== 'tool' && (!previous || (previous.role === 'user') !== (turn.role === 'user'));
        return (
          <li key={i} className={`msg msg-${turn.role}`}>
            {named ? <span className="msg-who">{speaker}</span> : null}
            {/* Paths inside the conversation's folder read shorter relative to it. */}
            {turn.role === 'tool' ? <code>{cwd ? turn.text.split(`${cwd}/`).join('') : turn.text}</code> : <p>{turn.text}</p>}
          </li>
        );
      })}
    </ol>
  );
}

/* ── resuming as another account ──────────────────────────────────────── */

function ChooseAccount({ item, accounts, accountsError, preferred, onClose, onStart }: {
  item: HistoryItem; accounts: Account[]; accountsError: Error | null; preferred: string | null; onClose: () => void; onStart: (accountId: string) => void;
}) {
  const home = accounts.find((a) => a.id === item.accountId);
  const others = accounts
    .filter((a) => a.provider === item.provider && a.id !== item.accountId && a.folderOk && a.signedIn !== 'no')
    .sort((a, b) => Number(b.id === preferred || (!preferred && b.isDefault)) - Number(a.id === preferred || (!preferred && a.isDefault)));
  const [choice, setChoice] = useState(item.accountId);
  const chosen = accounts.find((a) => a.id === choice);
  const homeLabel = home?.label ?? item.accountLabel;
  return (
    <Dialog title="Resume this conversation" onClose={onClose} footer={(
      <>
        <Button tone="quiet" onClick={onClose}>Cancel</Button>
        <Button tone="primary" icon="resume" onClick={() => onStart(choice)}>
          {choice === item.accountId ? `Resume as ${homeLabel}` : `Continue as ${chosen?.label ?? 'that account'}`}
        </Button>
      </>
    )}>
      <p className="choose-title">{heading(item).title}</p>
      <div className="choose-accounts" role="radiogroup" aria-label="Account to continue as">
        <label className="check-row">
          <input type="radio" name="history-account" checked={choice === item.accountId} onChange={() => setChoice(item.accountId)} />
          <span><strong>Resume as {homeLabel}</strong><span className="choose-why">The same conversation, in the account it lives in.</span></span>
        </label>
        {others.map((a) => (
          <label key={a.id} className="check-row">
            <input type="radio" name="history-account" checked={choice === a.id} onChange={() => setChoice(a.id)} />
            <span>
              <strong>Continue as {a.label}</strong>
              <span className="choose-why">A copy with a new id, kept under {a.label}. The one in {homeLabel} stays as it was.</span>
            </span>
          </label>
        ))}
      </div>
      {accountsError ? <p className="error-text small" role="alert">Wanigan could not list your other accounts: {accountsError.message}. It can still resume in its own.</p> : null}
      <p className="field-hint">Either way the whole conversation is sent to the model again, which uses part of that account’s limits.</p>
    </Dialog>
  );
}

/* ── words ────────────────────────────────────────────────────────────── */

/** The title, or the first prompt standing in for one; and the line under it. */
function heading(item: HistoryItem): { title: string; snippet: string | null } {
  if (item.title) return { title: item.title, snippet: item.firstPrompt ?? item.description };
  return { title: item.firstPrompt ?? 'Untitled conversation', snippet: item.description };
}

function groupOf(at: number, now: Date): Group {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (at >= today) return 'Today';
  if (at >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()) return 'Yesterday';
  // Weeks start on Monday.
  if (at >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime()) return 'This week';
  return 'Earlier';
}

function when(at: number, group: Group): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (group === 'Today' || group === 'Yesterday') return time;
  if (group === 'This week') return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return fullDate(at);
}

function fullDate(at: number): string {
  const d = new Date(at);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
