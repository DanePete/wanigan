import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttentionKind, Session, SessionStatus } from '@shared/types';

/**
 * A composer beside the PTY, not instead of it.
 *
 * The terminal stays authoritative — every keystroke typed into it behaves
 * exactly as in a shell. This strip exists for the three things a raw TTY line
 * is bad at: drafting multi-line prompts without fighting the TUI's Enter,
 * holding a message until the agent is actually listening, and reusing
 * prompts you have already written once.
 *
 * Nothing here invents a protocol. A send is the same bytes a terminal paste
 * plus Enter would produce, delivered through the same sessions:write channel.
 */

/** Same order of magnitude as the PTY input bound, with room for escapes. */
export const COMPOSER_MAX_CHARS = 100_000;
/** Show the countdown once a draft is within this of the cap. */
const COUNTDOWN_AT = 4_000;
/** The pause between a bracketed paste and the Enter that submits it. */
const SUBMIT_DELAY_MS = 120;
/** Attention is re-read on this cadence while a queue is waiting. */
const QUEUE_POLL_MS = 2_000;
const STASH_KEY = 'wanigan.promptStash';
const STASH_MAX = 50;
const DRAFT_PREFIX = 'wanigan.composerDraft.';

export type ComposerSendState = {
  mode: 'send' | 'queue' | 'blocked';
  /** The sentence behind the button label; null when mode is plain send. */
  reason: string | null;
};

/**
 * When a send is safe. Idle and finished mean the TUI is at its own prompt.
 * A permission prompt must never be answered by queued text, an errored
 * session should hear from a human first, and an unknown state fails closed —
 * queueing costs seconds, a mis-send costs a wrong approval.
 */
export function deriveSendState(input: {
  status: SessionStatus | null;
  attention: AttentionKind | null;
}): ComposerSendState {
  if (input.status !== 'running') {
    return { mode: 'blocked', reason: 'This session has exited, so there is no prompt to type into.' };
  }
  switch (input.attention) {
    case 'idle':
    case 'finished':
      return { mode: 'send', reason: null };
    case 'permission':
      return { mode: 'queue', reason: 'The agent is waiting on a permission prompt — queued text must not answer it.' };
    case 'error':
      return { mode: 'queue', reason: 'The agent stopped on an error; queued messages hold until it is idle again.' };
    case 'working':
      return { mode: 'queue', reason: 'The agent is mid-turn; this sends when it goes idle.' };
    default:
      return { mode: 'queue', reason: 'The agent’s state is not known yet; queued until it reads idle.' };
  }
}

/**
 * The bytes a send writes. A single line is text plus Enter, exactly like the
 * launch-prompt path. A multi-line body goes as one bracketed paste — the same
 * escape framing a real terminal emits — so the TUI treats interior newlines
 * as content rather than eleven submits.
 */
export function buildPtyPayload(text: string): string[] {
  const body = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (!body) return [];
  if (!body.includes('\n')) return [`${body}\r`];
  return [`\x1b[200~${body}\x1b[201~`, '\r'];
}

async function writePayload(sessionId: string, payload: string[]): Promise<void> {
  for (let i = 0; i < payload.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
    window.wanigan.sessions.write(sessionId, payload[i]);
  }
}

/* ── queue store ─────────────────────────────────────────────────────────
   Module-level so queued messages keep draining while another session is on
   screen. In-memory on purpose: the queue's lifetime is the PTY's lifetime,
   and a PTY does not survive a quit. */

type QueuedMessage = { id: number; text: string; queuedAt: number };
let queueSeq = 1;
const queues = new Map<string, QueuedMessage[]>();
const queueListeners = new Set<() => void>();
let watcher: number | undefined;
/** One send per idle sighting: the drained message makes the agent busy again,
    and the next queued one waits for the next real idle. */
let draining = false;

function notifyQueues() {
  for (const cb of queueListeners) { try { cb(); } catch { /* one bad subscriber */ } }
  syncWatcher();
}

export function queuedFor(sessionId: string): QueuedMessage[] {
  return queues.get(sessionId) ?? [];
}

function enqueue(sessionId: string, text: string) {
  queues.set(sessionId, [...queuedFor(sessionId), { id: queueSeq++, text, queuedAt: Date.now() }]);
  notifyQueues();
}

function unqueue(sessionId: string, id: number): QueuedMessage | null {
  const list = queuedFor(sessionId);
  const found = list.find((m) => m.id === id) ?? null;
  queues.set(sessionId, list.filter((m) => m.id !== id));
  if (!queues.get(sessionId)?.length) queues.delete(sessionId);
  notifyQueues();
  return found;
}

function syncWatcher() {
  const wanted = queues.size > 0;
  if (wanted && watcher === undefined) {
    watcher = window.setInterval(() => { void drainOnce(); }, QUEUE_POLL_MS);
  } else if (!wanted && watcher !== undefined) {
    window.clearInterval(watcher);
    watcher = undefined;
  }
}

async function drainOnce(): Promise<void> {
  if (draining || queues.size === 0) return;
  draining = true;
  try {
    const [attention, sessions] = await Promise.all([
      window.wanigan.attention.list(),
      window.wanigan.sessions.list(),
    ]);
    const kindOf = new Map(attention.map((a) => [a.sessionId, a.kind]));
    const statusOf = new Map(sessions.map((s) => [s.id, s.status]));
    for (const [sessionId, list] of [...queues.entries()]) {
      if (!list.length) continue;
      const state = deriveSendState({
        status: statusOf.get(sessionId) ?? null,
        attention: kindOf.get(sessionId) ?? null,
      });
      if (state.mode !== 'send') continue;
      const head = list[0];
      unqueue(sessionId, head.id);
      await writePayload(sessionId, buildPtyPayload(head.text));
    }
  } catch { /* the next tick re-reads; a failed poll must not drop a message */ }
  finally { draining = false; }
}

/* ── stash ───────────────────────────────────────────────────────────── */

type StashEntry = { id: number; text: string; at: number };

function readStash(): StashEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STASH_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is StashEntry =>
      !!e && typeof e === 'object'
      && typeof (e as StashEntry).id === 'number'
      && typeof (e as StashEntry).text === 'string'
      && typeof (e as StashEntry).at === 'number');
  } catch { return []; }
}

function writeStash(entries: StashEntry[]) {
  try { localStorage.setItem(STASH_KEY, JSON.stringify(entries.slice(0, STASH_MAX))); }
  catch { /* a full quota costs the stash, not the draft */ }
}

/* ── skills menu ─────────────────────────────────────────────────────── */

type SkillOption = { name: string; invoke: string; description: string; source: string };

/** The `$word` being typed at the caret, or null when the menu should close. */
export function skillTokenAt(text: string, caret: number): { start: number; query: string } | null {
  const head = text.slice(0, caret);
  const match = /(^|\s)\$([A-Za-z0-9_-]*)$/.exec(head);
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2].toLowerCase() };
}

export function rankSkills(options: SkillOption[], query: string, cap = 6): SkillOption[] {
  if (!query) return options.slice(0, cap);
  const q = query.toLowerCase();
  const starts = options.filter((s) => s.name.toLowerCase().startsWith(q));
  const contains = options.filter((s) => !s.name.toLowerCase().startsWith(q) && s.name.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, cap);
}

/* ── component ───────────────────────────────────────────────────────── */

export default function Composer({ session, onError, onCollapse }: {
  session: Session;
  onError: (message: string) => void;
  onCollapse?: () => void;
}) {
  const sessionId = session.id;
  const [draft, setDraft] = useState(() => localStorage.getItem(DRAFT_PREFIX + sessionId) ?? '');
  const [attention, setAttention] = useState<AttentionKind | null>(null);
  const [queued, setQueued] = useState<QueuedMessage[]>(() => queuedFor(sessionId));
  const [stash, setStash] = useState<StashEntry[]>(readStash);
  const [stashOpen, setStashOpen] = useState(false);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [menu, setMenu] = useState<{ start: number; query: string; index: number } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Drafts are per session and survive a reload; queues deliberately do not.
  useEffect(() => { setDraft(localStorage.getItem(DRAFT_PREFIX + sessionId) ?? ''); setMenu(null); }, [sessionId]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        if (draft) localStorage.setItem(DRAFT_PREFIX + sessionId, draft);
        else localStorage.removeItem(DRAFT_PREFIX + sessionId);
      } catch { /* quota */ }
    }, 300);
    return () => window.clearTimeout(t);
  }, [draft, sessionId]);

  useEffect(() => {
    const sync = () => setQueued(queuedFor(sessionId));
    sync();
    queueListeners.add(sync);
    return () => { queueListeners.delete(sync); };
  }, [sessionId]);

  // The send button's honesty depends on fresh attention; poll gently and
  // catch up immediately on this session's own events.
  useEffect(() => {
    let alive = true;
    const read = () => {
      window.wanigan.attention.list()
        .then((list) => { if (alive) setAttention(list.find((a) => a.sessionId === sessionId)?.kind ?? null); })
        .catch(() => {});
    };
    read();
    const t = window.setInterval(read, QUEUE_POLL_MS);
    const off = window.wanigan.on.sessionEvent((e) => { if (e.sessionId === sessionId) read(); });
    return () => { alive = false; window.clearInterval(t); off(); };
  }, [sessionId]);

  useEffect(() => {
    window.wanigan.skills.list(session.projectId)
      .then((cat: { skills?: SkillOption[] }) => setSkills((cat.skills ?? []).map(
        (s) => ({ name: s.name, invoke: s.invoke, description: s.description, source: s.source }))))
      .catch(() => setSkills([]));
  }, [session.projectId]);

  const state = deriveSendState({ status: session.status, attention });
  const over = draft.length - COMPOSER_MAX_CHARS;
  const menuOptions = useMemo(
    () => (menu ? rankSkills(skills, menu.query) : []),
    [menu, skills],
  );

  const insertSkill = useCallback((option: SkillOption) => {
    const el = areaRef.current;
    if (!el || !menu) return;
    const caret = el.selectionStart ?? draft.length;
    const next = `${draft.slice(0, menu.start)}${option.invoke} ${draft.slice(caret)}`;
    setDraft(next);
    setMenu(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = menu.start + option.invoke.length + 1;
      el.setSelectionRange(pos, pos);
    });
  }, [draft, menu]);

  const send = useCallback(async (forced?: string) => {
    const text = (forced ?? draft).trim();
    if (!text || state.mode === 'blocked') return;
    if (text.length > COMPOSER_MAX_CHARS) return;
    if (forced === undefined) {
      setDraft('');
      setMenu(null);
    }
    if (state.mode === 'queue' && forced === undefined) {
      enqueue(sessionId, text);
      return;
    }
    try { await writePayload(sessionId, buildPtyPayload(text)); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  }, [draft, onError, sessionId, state.mode]);

  const stashDraft = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    const next = [{ id: Date.now(), text, at: Date.now() }, ...readStash()];
    writeStash(next);
    setStash(next.slice(0, STASH_MAX));
    setFlash('Stashed — restore it from ⧉ any time, in any session.');
    window.setTimeout(() => setFlash(null), 3500);
  }, [draft]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && menuOptions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenu({ ...menu, index: (menu.index + 1) % menuOptions.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenu({ ...menu, index: (menu.index - 1 + menuOptions.length) % menuOptions.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertSkill(menuOptions[menu.index]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); stashDraft(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      void send();
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value.slice(0, COMPOSER_MAX_CHARS + 1_000));
    const token = skillTokenAt(e.target.value, e.target.selectionStart ?? e.target.value.length);
    setMenu(token ? { ...token, index: 0 } : null);
  };

  const buttonLabel = state.mode === 'queue' ? 'Queue' : 'Send';
  const disabled = state.mode === 'blocked' || !draft.trim() || over > 0;

  return (
    <div className="composer" data-state={state.mode}>
      {queued.length > 0 && (
        <div className="composer-queue" role="list" aria-label="Queued messages">
          {queued.map((m) => (
            <span key={m.id} className="composer-chip" role="listitem" title={m.text}>
              <span className="composer-chip-text">{m.text}</span>
              <button type="button" className="composer-chip-btn"
                      title="Send now, regardless of the agent’s state — you can see the terminal"
                      onClick={() => { const taken = unqueue(sessionId, m.id); if (taken) void send(taken.text); }}>
                send now
              </button>
              <button type="button" className="composer-chip-btn" title="Remove without sending"
                      aria-label={`Remove queued message: ${m.text.slice(0, 60)}`}
                      onClick={() => unqueue(sessionId, m.id)}>×</button>
            </span>
          ))}
          <span className="faint composer-queue-note">
            {state.mode === 'send' ? 'sending…' : 'sends when the agent is idle'}
          </span>
        </div>
      )}
      <div className="composer-row">
        <div className="composer-field">
          <textarea
            ref={areaRef}
            className="composer-area"
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            value={draft}
            placeholder={state.mode === 'blocked'
              ? 'Session exited — resume it from Recent to keep talking'
              : 'Message the agent — Enter sends, Shift+Enter for a new line, $ inserts a skill, ⌘S stashes'}
            aria-label="Message the agent"
            disabled={state.mode === 'blocked'}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onBlur={() => window.setTimeout(() => setMenu(null), 150)}
          />
          {menu && menuOptions.length > 0 && (
            <ul className="composer-menu" role="listbox" aria-label="Skills">
              {menuOptions.map((option, i) => (
                <li key={option.invoke}>
                  <button type="button" role="option" aria-selected={i === menu.index}
                          className={`composer-menu-item${i === menu.index ? ' on' : ''}`}
                          onMouseDown={(e) => { e.preventDefault(); insertSkill(option); }}>
                    <span className="mono">{option.invoke}</span>
                    <span className="faint composer-menu-desc">{option.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="composer-actions">
          {onCollapse && (
            <button type="button" className="composer-chip-btn" title="Hide the composer (⌘E brings it back)"
                    aria-label="Hide the composer" onClick={onCollapse}>⌄</button>
          )}
          <button type="button" className="btn composer-stash" title="Stashed prompts"
                  aria-expanded={stashOpen} onClick={() => setStashOpen((o) => !o)}>⧉{stash.length ? ` ${stash.length}` : ''}</button>
          <button type="button" className="btn btn-primary composer-send" disabled={disabled}
                  title={state.reason ?? 'Send to the agent’s prompt'}
                  onClick={() => void send()}>
            {buttonLabel}
          </button>
        </div>
      </div>
      {(state.reason || flash || over > -COUNTDOWN_AT) && (
        <div className="composer-note faint">
          {flash ?? state.reason ?? ''}
          {over > -COUNTDOWN_AT && (
            <span className="mono" style={over > 0 ? { color: 'var(--critical)' } : undefined}>
              {over > 0
                ? ` ${over.toLocaleString('en-US')} over the ${COMPOSER_MAX_CHARS.toLocaleString('en-US')}-character limit`
                : ` ${(-over).toLocaleString('en-US')} characters left`}
            </span>
          )}
        </div>
      )}
      {stashOpen && (
        <div className="composer-stash-pop">
          {stash.length === 0 && <p className="faint composer-stash-empty">Nothing stashed yet — ⌘S in the composer keeps a prompt for later.</p>}
          {stash.map((entry) => (
            <div key={entry.id} className="composer-stash-row">
              <button type="button" className="composer-stash-restore" title={entry.text}
                      onClick={() => { setDraft(entry.text); setStashOpen(false); areaRef.current?.focus(); }}>
                {entry.text}
              </button>
              <button type="button" className="composer-chip-btn" title="Delete from the stash"
                      aria-label={`Delete stashed prompt: ${entry.text.slice(0, 60)}`}
                      onClick={() => { const next = stash.filter((s) => s.id !== entry.id); writeStash(next); setStash(next); }}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
