// A project's History: every earlier Claude Code and Codex conversation in its
// folder, wherever it ran (a terminal, VS Code or here), to read or
// to pick up again as a live session.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Account, HistoryItem, HistoryTurn, ProjectSummary } from '@shared/model';
import { attempt, call, useQuery } from '../lib/api';
import { href, navigate } from '../lib/router';
import { PROVIDER_LABEL, plural } from '../lib/format';
import { Icon } from '../components/icons';
import { Button, Dialog, IconButton, NotAnswering, useToast } from '../components/ui';

const GROUPS = ['Today', 'Yesterday', 'This week', 'Earlier'] as const;
type Group = (typeof GROUPS)[number];

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
  const [readingId, setReadingId] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<HistoryItem | null>(null);

  const items = history.data ?? [];
  const reading = items.find((i) => i.id === readingId) ?? null;
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

  return (
    <div className="history">
      <div className="toolbar history-bar">
        <label className="search-field">
          <Icon name="search" size={14} />
          <span className="visually-hidden">Search conversations</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles, prompts and branches" />
        </label>
        <span className="toolbar-end faint">{waiting ? 'Searching…' : history.error ? 'Could not read history' : `${items.length === 500 ? 'Newest ' : ''}${count}`}</span>
      </div>
      <div className="view-pad history-list">
        {history.error ? <NotAnswering error={history.error} onRetry={history.reload} title="History could not be loaded" /> : waiting ? <p className="faint">Reading this folder’s conversations…</p> : groups.map(({ group, items: rows }) => (
          <section key={group} aria-labelledby={`history-${group}`}>
            <h2 className="section-title" id={`history-${group}`}>{group}</h2>
            <ol className="hrows">
              {rows.map((item) => (
                <HistoryRow key={item.id} item={item} group={group} showAccount={several[item.provider]} active={readingId === item.id}
                  pausedAt={project.pausedAt} onRead={() => setReadingId(item.id)} onResume={() => resume(item)} />
              ))}
            </ol>
          </section>
        ))}
        {!history.error && !waiting && !items.length ? <p className="faint">{search ? `Nothing matches “${query}”.` : 'No Claude Code or Codex conversation has run in this folder yet.'}</p> : null}
      </div>
      {reading ? (
        <Reader item={reading} projectKey={project.key} pausedAt={project.pausedAt} onClose={() => setReadingId(null)} onResume={() => resume(reading)} />
      ) : null}
      {choosing ? (
        <ChooseAccount item={choosing} accounts={accounts.data ?? []} accountsError={accounts.error} preferred={project.accounts.claude ?? null} onClose={() => setChoosing(null)}
          onStart={(accountId) => { setChoosing(null); void start(choosing, accountId); }} />
      ) : null}
    </div>
  );
}

function HistoryRow({ item, group, showAccount, active, pausedAt, onRead, onResume }: {
  item: HistoryItem; group: Group; showAccount: boolean; active: boolean; pausedAt: number | null; onRead: () => void; onResume: () => void;
}) {
  const { title, snippet } = heading(item);
  return (
    <li className={`hrow${active ? ' active' : ''}`}>
      <ProviderMark provider={item.provider} />
      {/* The text is a larger target for the mouse; Read is the same action for the keyboard. */}
      <div className="hrow-main" onClick={onRead}>
        <span className="hrow-title">{title}</span>
        {snippet ? <span className="hrow-prompt">{snippet}</span> : null}
        <span className="hrow-meta">
          <time dateTime={new Date(item.updatedAt).toISOString()}>{when(item.updatedAt, group)}</time>
          {item.branch ? <span className="mono hrow-branch">{item.branch}</span> : null}
          {item.cardKey ? <span className="mono">{item.cardKey}</span> : null}
          {showAccount ? <span>{item.accountLabel}</span> : null}
          <Tags item={item} />
        </span>
      </div>
      <div className="hrow-actions">
        <Button size="s" tone="quiet" icon="note" onClick={onRead} aria-label={`Read ${title}`}>Read</Button>
        <ResumeButton item={item} pausedAt={pausedAt} onResume={onResume} label={title} />
      </div>
    </li>
  );
}

function ResumeButton({ item, pausedAt, onResume, label, tone = 'plain' }: {
  item: HistoryItem; pausedAt: number | null; onResume: () => void; label: string; tone?: 'plain' | 'primary';
}) {
  if (item.live && item.sessionId) {
    return <Button size="s" tone={tone} icon="terminal" onClick={onResume} aria-label={`Open the live session for ${label}`}>Open</Button>;
  }
  return (
    <Button size="s" tone={tone} icon="resume" onClick={onResume} disabled={!!pausedAt} aria-label={`Resume ${label}`}
      title={pausedAt ? 'Paused: resume the project to start sessions' : 'Continue this conversation in a new session. It re-sends the conversation, which uses part of the account’s limits.'}>
      Resume
    </Button>
  );
}

function Tags({ item }: { item: HistoryItem }) {
  return (
    <>
      {item.live ? <span className="badge">Live</span> : null}
      {item.via ? <span className="tag">{item.via}</span> : null}
    </>
  );
}

function ProviderMark({ provider }: { provider: HistoryItem['provider'] }) {
  return (
    <span className={`hmark hmark-${provider}`} title={PROVIDER_LABEL[provider]}>
      <Icon name={provider} size={15} />
      <span className="visually-hidden">{PROVIDER_LABEL[provider]}</span>
    </span>
  );
}

/* ── reader ───────────────────────────────────────────────────────────── */

function Reader({ item, projectKey, pausedAt, onClose, onResume }: {
  item: HistoryItem; projectKey: string; pausedAt: number | null; onClose: () => void; onResume: () => void;
}) {
  const transcript = useQuery('history.read', { id: item.id }, []);
  const panel = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const { title } = heading(item);
  const close = useRef(onClose);
  close.current = onClose;

  // Focus comes here when a conversation opens, Escape closes it, and focus goes back where it was.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('[aria-modal="true"]')) close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); before?.focus?.(); };
  }, [item.id]);

  // The newest turn is at the bottom, and that is where reading starts.
  useEffect(() => {
    if (transcript.data && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [transcript.data]);

  const agent = PROVIDER_LABEL[item.provider];
  return (
    <aside className="drawer reader" aria-label={`Conversation: ${title}`} ref={panel} tabIndex={-1}>
      <header className="reader-head">
        <div className="reader-top">
          <ProviderMark provider={item.provider} />
          <h2 className="reader-title">{title}</h2>
          <IconButton icon="close" label="Close the conversation" onClick={onClose} />
        </div>
        <p className="reader-meta">
          <span>{agent} as {item.accountLabel}</span>
          {item.branch ? <span className="mono">{item.branch}</span> : null}
          {item.startedAt && fullDate(item.startedAt) !== fullDate(item.updatedAt) ? <span>started {fullDate(item.startedAt)}</span> : null}
          <time dateTime={new Date(item.updatedAt).toISOString()}>{fullDate(item.updatedAt)}, {new Date(item.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
          <Tags item={item} />
        </p>
        {item.description ? <p className="reader-description">{item.description}</p> : null}
        <div className="row-gap reader-actions">
          <ResumeButton item={item} pausedAt={pausedAt} onResume={onResume} label={title} tone="primary" />
          {item.sessionId && !item.live ? <a className="small" href={href({ name: 'session', projectKey, sessionId: item.sessionId })}>Its last session here</a> : null}
        </div>
      </header>
      <div className="reader-body" ref={body}>
        {transcript.error ? <p className="error-text">{transcript.error.message}</p>
          : !transcript.data ? <p className="faint">Reading the conversation…</p>
            : (
              <>
                {transcript.data.truncated ? <p className="reader-note">Earlier turns are left out. This is the most recent part of the conversation.</p> : null}
                {transcript.data.turns.length ? <Turns turns={transcript.data.turns} agent={agent} cwd={item.cwd} />
                  : <p className="faint">This conversation has no text to show.</p>}
              </>
            )}
      </div>
    </aside>
  );
}

function Turns({ turns, agent, cwd }: { turns: HistoryTurn[]; agent: string; cwd: string | null }) {
  return (
    <ol className="turns">
      {turns.map((turn, i) => {
        const speaker = turn.role === 'user' ? 'You' : agent;
        const previous = turns[i - 1];
        const named = turn.role !== 'tool' && (!previous || (previous.role === 'user') !== (turn.role === 'user'));
        return (
          <li key={i} className={`turn turn-${turn.role}`}>
            {named ? <span className="turn-who">{speaker}</span> : null}
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
