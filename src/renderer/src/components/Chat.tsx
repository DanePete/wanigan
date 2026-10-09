// Talk to Wanigan: a round button at the bottom right of every view, holding a
// small live orb, and the conversation it opens. Claude Code answers as
// Wanigan, on the owner's plan, read-only, and only when the owner sends a
// message (the core runs it: core/chat.ts). Advice only.
import { Select } from './Select';
import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CHAT_MAX_QUESTION, CARD_KEY_PATTERN, type ChatThread, type ChatTurn } from '@shared/chat';
import type { Account, ProjectSummary } from '@shared/model';
import { attempt, call, useQuery } from '../lib/api';
import { useDraft } from '../lib/draft';
import { openCard } from '../lib/router';
import { ago } from '../lib/format';
import { Orb, type OrbSignal } from './Orb';
import { PlayableOrb } from './PlayableOrb';
import { useMaterial } from '../lib/material';
import type { OrbMood } from '../orb/mood';
import { Button, IconButton, Segmented, useFocusTrap, useToast } from './ui';
import { AttachButton, AttachmentChips, useAttachments, useFileDrop } from './Attachments';
import { receivesLine } from '@shared/attachments';

/*
 * What the chat asks of the orb, for both the button and the conversation.
 * Here he is Wanigan himself, so his water is clear, not tinted by what needs
 * you (the rail and Needs you say that). While he answers, the water swirls;
 * when an answer lands, he celebrates once.
 */
function useChatOrb(thinking: boolean, landed: string | null): { signal: OrbSignal; mood: OrbMood } {
  const first = useRef(landed);
  const [celebrating, setCelebrating] = useState(false);
  useEffect(() => {
    if (!landed || landed === first.current) return;
    first.current = landed;
    setCelebrating(true);
    // Back to idle, so the next answer celebrates again.
    const t = window.setTimeout(() => setCelebrating(false), 2500);
    return () => window.clearTimeout(t);
  }, [landed]);
  return { signal: 'quiet', mood: thinking ? 'thinking' : celebrating ? 'celebrate' : 'idle' };
}

export function TalkToWanigan({ project, hidden }: {
  /** The project being looked at, if any: the chat opens about it. */
  project: ProjectSummary | undefined;
  /** No button here (the session view, whose composer sits at the bottom right). */
  hidden: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  useEffect(() => { setEverywhere(false); }, [project?.id]);
  const scopeId = project && !everywhere ? project.id : null;
  const thread = useQuery('chat.list', { projectId: scopeId }, ['chat', 'accounts', 'projects'],
    (event, data) => event !== 'chat' || (data as { projectId: string | null }).projectId === scopeId);
  const turns = thread.data?.turns ?? [];
  const thinking = turns.some((t) => t.state === 'running');
  const landed = [...turns].reverse().find((t) => t.state === 'done')?.id ?? null;
  const orb = useChatOrb(thinking, landed);
  const material = useMaterial();

  // An answer that arrives while the conversation is closed is marked on the button.
  const [seen, setSeen] = useState<{ scope: string | null; turn: string | null } | null>(null);
  useEffect(() => {
    if (!thread.data) return;
    if (open || !seen || seen.scope !== scopeId) setSeen({ scope: scopeId, turn: landed });
  }, [open, landed, scopeId, thread.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const unread = !open && !!landed && seen?.scope === scopeId && seen.turn !== landed;

  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) button.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      {open || hidden ? null : (
        <button
          ref={button}
          type="button"
          className={`chat-fab${thinking ? ' thinking' : ''}`}
          aria-haspopup="dialog"
          aria-label={`Talk to Wanigan${thinking ? ' (answering)' : unread ? ' (new answer)' : ''}`}
          title="Talk to Wanigan"
          onClick={() => setOpen(true)}
        >
          <Orb size={44} {...orb} material={material} />
          {unread ? <span className="chat-fab-dot" aria-hidden="true" /> : null}
        </button>
      )}
      {open ? (
        <ChatSheet
          project={project}
          everywhere={everywhere}
          setEverywhere={setEverywhere}
          thread={thread.data}
          error={thread.error}
          orb={orb}
          onClose={close}
        />
      ) : null}
    </>
  );
}

function ChatSheet({ project, everywhere, setEverywhere, thread, error, orb, onClose }: {
  project: ProjectSummary | undefined;
  everywhere: boolean;
  setEverywhere: (all: boolean) => void;
  thread: ChatThread | undefined;
  error: Error | null;
  orb: { signal: OrbSignal; mood: OrbMood };
  onClose: () => void;
}) {
  const toast = useToast();
  const titleId = useId();
  const inputId = useId();
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useFocusTrap(box, onClose);
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const claude = (accounts.data ?? []).filter((a) => a.provider === 'claude');
  const { text, setText, clear } = useDraft();
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scope = project && !everywhere ? project : null;
  // Images and files pasted or dropped anywhere in the conversation, or picked, go with the next message.
  const attach = useAttachments({ chat: scope?.id ?? null });
  useFileDrop(box, (files) => { void attach.add(files); });
  const turns = thread?.turns ?? [];
  const thinking = turns.some((t) => t.state === 'running');
  const accountId = (turns.length ? null : picked) ?? thread?.accountId ?? null;
  const account = claude.find((a) => a.id === accountId);

  useEffect(() => { setPicked(null); }, [scope?.id]);

  // Keep the newest message in view.
  const last = turns.at(-1);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, last?.state, last?.id]);

  // The box grows with what is typed, up to a few lines.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const files = attach.files.map((f) => f.id);
  const send = async (): Promise<void> => {
    const message = text.trim();
    if ((!message && !files.length) || thinking || busy || attach.adding) return;
    setBusy(true);
    const sent = await attempt(
      () => call('chat.send', {
        projectId: scope?.id ?? null, text: message, ...(accountId && !turns.length ? { accountId } : {}), ...(files.length ? { attachments: files } : {}),
      }),
      (m) => toast(m, 'error'),
    );
    setBusy(false);
    if (sent) clear();
  };
  const stop = (): Promise<unknown> => attempt(() => call('chat.cancel', { projectId: scope?.id ?? null }), (m) => toast(m, 'error'));
  const reset = (): Promise<void> => attempt(() => call('chat.reset', { projectId: scope?.id ?? null }), (m) => toast(m, 'error')).then(() => input.current?.focus());
  const showCard = (key: string): void => { onClose(); openCard(key); };
  const ask = (starter: string): void => { setText(starter); input.current?.focus(); };

  return createPortal(
    <div className="scrim chat-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="chat" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={box}>
        <header className="chat-head">
          <div className={`chat-orb${thinking ? ' thinking' : ''}`}>
            <PlayableOrb size={128} signal={orb.signal} mood={orb.mood} />
          </div>
          <div className="chat-words">
            <h2 id={titleId}>Talk to Wanigan</h2>
            <p className="chat-scope">
              {scope ? <>About <b>{scope.name}</b>. Reads its files; changes nothing.</> : <>About every project. Reads Wanigan’s records; changes nothing.</>}
            </p>
            {project ? (
              <Segmented<'project' | 'all'>
                size="s"
                label="What to talk about"
                value={everywhere ? 'all' : 'project'}
                onChange={(v) => setEverywhere(v === 'all')}
                options={[{ value: 'project', label: 'This project' }, { value: 'all', label: 'Every project' }]}
              />
            ) : null}
          </div>
          <div className="chat-tools">
            <IconButton icon="plus" label="New conversation" onClick={reset} disabled={thinking || !turns.length}
              title={thinking ? 'New conversation, once Wanigan has answered or you stop it' : !turns.length ? 'This conversation is new: nothing to start over' : 'New conversation'} />
            <IconButton icon="close" label="Close" onClick={onClose} />
          </div>
        </header>

        <div className="chat-thread" ref={scroller} aria-live="polite">
          {error ? <p className="error-text small">{error.message}</p> : null}
          {thread && thread.earlier ? (
            <p className="chat-earlier">{thread.earlier} earlier {thread.earlier === 1 ? 'message' : 'messages'} in this conversation are not shown.</p>
          ) : null}
          {thread && !turns.length ? <Starters project={scope} onPick={ask} /> : null}
          {turns.map((turn, i) => (
            <Turn
              key={turn.id}
              turn={turn}
              first={i === 0 && !thread?.earlier}
              account={claude.length > 1 ? claude.find((a) => a.id === turn.accountId) : undefined}
              project={scope}
              onCard={showCard}
              onStop={stop}
            />
          ))}
        </div>

        {attach.files.length || attach.adding ? (
          <div className="chat-files">
            <AttachmentChips files={attach.files} adding={attach.adding} onRemove={attach.remove} />
            <p className="attach-note">{receivesLine('chat')}</p>
          </div>
        ) : null}
        <form className="chat-compose" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <AttachButton onPick={attach.pick} disabled={thinking} />
          <label className="visually-hidden" htmlFor={inputId}>Message Wanigan</label>
          <textarea
            ref={input}
            id={inputId}
            data-autofocus
            rows={1}
            value={text}
            maxLength={CHAT_MAX_QUESTION}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
            }}
            placeholder={scope ? `Ask about ${scope.name}` : 'Ask about your projects'}
          />
          {thinking ? (
            <Button tone="quiet" icon="stop" onClick={stop}>Stop</Button>
          ) : (
            <Button tone="primary" type="submit" icon="send" disabled={(!text.trim() && !files.length) || busy || attach.adding > 0}>Send</Button>
          )}
        </form>
        <div className="chat-hint">
          <span>
            Uses a turn of{' '}
            {claude.length > 1 && !turns.length ? (
              <Select className="chat-account" label="Account to answer with" size="s" value={accountId ?? ''} onChange={setPicked}
                options={claude.map((a) => ({ value: a.id, label: a.label, ...(a.signedIn === 'no' ? { detail: 'signed out' } : {}) }))} />
            ) : <b>{account?.label ?? 'your Claude account'}</b>}
            ’s plan.
          </span>
          <span className="chat-keys"><kbd>↩</kbd> send · <kbd>⇧</kbd><kbd>↩</kbd> new line</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Starters({ project, onPick }: { project: ProjectSummary | null; onPick: (text: string) => void }) {
  const starters = project
    ? ['What needs me here?', 'What is waiting on me in Review?', 'Summarize what the agents did today']
    : ['What needs me?', 'Summarize what the agents did today', 'Which project is busiest right now?'];
  return (
    <div className="chat-empty">
      <p className="chat-empty-title">Ask about the desk.</p>
      <p className="chat-empty-body">
        Wanigan answers from its own records: what needs you, sessions and what they are doing, cards in Review and
        Working, {project ? 'this project’s decisions, ' : ''}and today’s activity.{project ? ' It can read this project’s files too.' : ''}{' '}
        It is advice: Wanigan never moves a card or changes a file.
      </p>
      <div className="chat-starters">
        {starters.map((s) => <Button key={s} size="s" tone="plain" onClick={() => onPick(s)}>{s}</Button>)}
      </div>
    </div>
  );
}

function Turn({ turn, first, account, project, onCard, onStop }: {
  turn: ChatTurn;
  first: boolean;
  account: Account | undefined;
  project: ProjectSummary | null;
  onCard: (key: string) => void;
  onStop: () => void;
}) {
  const cost = turn.costUsd === null ? 'no cost reported' : `Claude Code reported ${turn.costUsd < 0.01 ? 'under $0.01' : `$${turn.costUsd.toFixed(2)}`}`;
  return (
    <article className={`chat-turn chat-turn-${turn.state}`}>
      {turn.question ? <p className="chat-q">{turn.question}</p> : null}
      {turn.attachments.length ? <AttachmentChips files={turn.attachments} label="Files sent with this message" /> : null}
      {turn.state === 'running' ? (
        <Thinking since={turn.askedAt} project={project} onStop={onStop} />
      ) : turn.state === 'done' && turn.answer ? (
        <div className="chat-a">
          <Answer text={turn.answer} cards={turn.cards} onCard={onCard} />
          <p className="chat-meta">
            {ago(turn.answeredAt)}{account ? ` · as ${account.label}` : ''} · {cost}
            {!first && !turn.continued ? ' · a new Claude conversation, so earlier messages were not remembered' : ''}
          </p>
        </div>
      ) : (
        <div className="chat-a">
          <p className={turn.state === 'stopped' ? 'chat-stopped' : 'chat-error'}>{turn.error ?? 'No answer.'}</p>
          {turn.costUsd !== null ? <p className="chat-meta">{cost}</p> : null}
        </div>
      )}
    </article>
  );
}

function Thinking({ since, project, onStop }: { since: number; project: ProjectSummary | null; onStop: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return (
    <div className="chat-a chat-thinking" role="status">
      <span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>
      <span>Wanigan is reading the board{project ? ' and the project' : ''}</span>
      <span className="chat-timer">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
      <button type="button" className="linkish" onClick={onStop}>Stop</button>
    </div>
  );
}

/* ── the answer, as plain text with a little structure ──────────────────── */

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul' | 'ol'; items: string[] };

/** Paragraphs and lists, nothing else: Wanigan is asked for plain text, and HTML is never rendered. */
function blocks(text: string): Block[] {
  const out: Block[] = [];
  let open = null as Block | null;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) { open = null; continue; }
    const item = line.match(/^(?:[-*•]|(\d+)[.)])\s+(.*)$/);
    if (item) {
      const kind = item[1] ? 'ol' : 'ul';
      if (open?.kind !== kind) { open = { kind, items: [] }; out.push(open); }
      (open as { items: string[] }).items.push(item[2] ?? '');
    } else if (open && open.kind !== 'p' && /^\s/.test(raw)) {
      const items = open.items;
      items[items.length - 1] = `${items[items.length - 1] ?? ''} ${line}`;
    } else {
      if (open?.kind !== 'p') { open = { kind: 'p', lines: [] }; out.push(open); }
      open.lines.push(line.replace(/^#+\s*/, ''));
    }
  }
  return out;
}

function Answer({ text, cards, onCard }: { text: string; cards: string[]; onCard: (key: string) => void }) {
  const inline = (s: string): ReactNode => <Inline text={s} cards={cards} onCard={onCard} />;
  return (
    <>
      {blocks(text).map((b, i) => {
        if (b.kind === 'p') return <p key={i}>{b.lines.map((l, j) => <Fragment key={j}>{j ? <br /> : null}{inline(l)}</Fragment>)}</p>;
        const List = b.kind;
        return <List key={i}>{b.items.map((item, j) => <li key={j}>{inline(item)}</li>)}</List>;
      })}
    </>
  );
}

const INLINE = new RegExp(`(\`[^\`]+\`|\\*\\*[^*]+\\*\\*|${CARD_KEY_PATTERN.source})`, 'g');

/** `code`, **bold**, and card keys that name a real card as links to it. */
function Inline({ text, cards, onCard }: { text: string; cards: string[]; onCard: (key: string) => void }) {
  return (
    <>
      {text.split(INLINE).map((part, i) => {
        if (i % 2 === 0) return part;
        if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
        if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
        return cards.includes(part)
          ? <button key={i} type="button" className="linkish mono" onClick={() => onCard(part)} title={`Open ${part}`}>{part}</button>
          : <span key={i} className="mono">{part}</span>;
      })}
    </>
  );
}
