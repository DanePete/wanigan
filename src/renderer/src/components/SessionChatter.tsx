import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, SessionEvent } from '@shared/types';

/**
 * Two agents talking, on screen, while it happens — as two characters.
 *
 * Claude Code sessions can message each other, and until now every word of it
 * happened in a terminal nobody was looking at. The operator's whole model of
 * their fleet is "nine agents working separately"; the moment two of them
 * coordinate, that model is wrong and nothing tells them. This card does, and
 * it does it as a scene rather than a log: the two parties stand at the top
 * facing each other, a message visibly crosses from one to the other, the
 * speaker squashes to talk and the listener bobs to hear, and the exchange
 * accumulates beneath them as a chat.
 *
 * Wanigan already receives all of it. PreToolUse is registered with matcher
 * '*', so a SendMessage call fires a hook the instant it is made — no poll, and
 * sooner than the team mailboxes under ~/.claude/teams, which hold only unread
 * mail and so miss every exchange that landed.
 *
 * What is shown is what was recorded: who sent, who received, and the sender's
 * own short label for it. Never the message. The body is one model's words to
 * another, and hooks.ts draws that line already — it reads `agent_type` off a
 * SubagentStop and leaves `last_assistant_message` alone. A card printing the
 * payload would be a transcript of other people's conversations, which is a
 * different product.
 *
 * On motion: motion.css's rule is that a moving thing is a claim about the
 * world. This surface is the one deliberate exception, granted by the operator
 * — the characters blink and breathe while idle, and the listener shows
 * waiting dots while a message they were sent has not been answered. Every
 * duration is a motion.css token, so reduced motion and Settings › Motion = off
 * still take all of it to zero; the words stay.
 */

/** Quiet for this long and the exchange is over, so the card leaves by itself. */
const SETTLE_MS = 16_000;
/** After this the listener's waiting dots stop: silence is an answer too. */
const REPLY_WINDOW_MS = 24_000;
/** How long the exit animation is given before the card unmounts. Matches --mo-view's ceiling. */
const LEAVE_MS = 380;
/** A conversation, not a log. Older lines scroll out of the card's memory. */
const MAX_LINES = 5;
const MAX_KEPT = 40;

type Side = 'left' | 'right';

type Party = { name: string; initial: string };

type Line = {
  id: string;
  at: number;
  from: string;
  to: string;
  label: string | null;
  /** Which character said it, so the bubble sits under the right one. */
  side: Side;
};

type Stage = {
  left: Party;
  right: Party;
  /** Who spoke last, so the packet flies the right way and the other one listens. */
  speaker: Side;
  /** Bumped per message; keys the stage so its animations replay. */
  tick: number;
};

/**
 * `to · label`, which is what hooks.ts stores for a SendMessage row. Split
 * rather than re-derived: the main process owns the wording.
 */
function split(summary: string | null): { to: string; label: string | null } {
  if (!summary) return { to: 'another session', label: null };
  const at = summary.indexOf(' · ');
  if (at < 0) return { to: summary.trim() || 'another session', label: null };
  return {
    to: summary.slice(0, at).trim() || 'another session',
    label: summary.slice(at + 3).trim() || null,
  };
}

function party(name: string): Party {
  const letter = name.trim().replace(/^[^\p{L}\p{N}]+/u, '').charAt(0);
  return { name, initial: (letter || '?').toUpperCase() };
}

/**
 * Where the new speaker stands. Two parties keep their places for as long as
 * they keep talking to each other; a third party walks on and the stage is
 * re-cast around them, which is what a person watching would do too.
 */
function cast(stage: Stage | null, from: string, to: string): Stage {
  if (stage) {
    if (from === stage.left.name && to === stage.right.name) return { ...stage, speaker: 'left', tick: stage.tick + 1 };
    if (from === stage.right.name && to === stage.left.name) return { ...stage, speaker: 'right', tick: stage.tick + 1 };
  }
  return { left: party(from), right: party(to), speaker: 'left', tick: (stage?.tick ?? 0) + 1 };
}

export default function SessionChatter() {
  const [lines, setLines] = useState<Line[]>([]);
  const [stage, setStage] = useState<Stage | null>(null);
  const [phase, setPhase] = useState<'hidden' | 'open' | 'leaving'>('hidden');
  /** The side whose reply is awaited, or null once they answer or the window closes. */
  const [awaiting, setAwaiting] = useState<Side | null>(null);

  const sessions = useRef<Record<string, Session>>({});
  const settle = useRef<number | null>(null);
  const replyWindow = useRef<number | null>(null);
  const leave = useRef<number | null>(null);
  const held = useRef(false);
  const alive = useRef(true);
  const stageRef = useRef<Stage | null>(null);
  stageRef.current = stage;

  const nameOf = useCallback((sessionId: string): string => {
    const session = sessions.current[sessionId];
    if (!session) return `session ${sessionId.slice(0, 6)}`;
    return session.projectName || session.title || `session ${sessionId.slice(0, 6)}`;
  }, []);

  const clear = (ref: React.MutableRefObject<number | null>) => {
    if (ref.current !== null) { window.clearTimeout(ref.current); ref.current = null; }
  };

  const close = useCallback(() => {
    clear(settle); clear(replyWindow);
    setAwaiting(null);
    setPhase('leaving');
    clear(leave);
    // A timer, not animationend: under reduced motion the exit animation is
    // zero-length and some engines never fire the event for one, which would
    // leave a card that can be neither read nor dismissed.
    leave.current = window.setTimeout(() => {
      leave.current = null;
      if (alive.current) setPhase('hidden');
    }, LEAVE_MS);
  }, []);

  const arm = useCallback(() => {
    clear(settle);
    settle.current = window.setTimeout(() => {
      settle.current = null;
      // Reading counts as using it: a card that vanished mid-sentence because
      // a timer ran out teaches people to screenshot it instead of reading it.
      if (held.current) { arm(); return; }
      if (alive.current) close();
    }, SETTLE_MS);
  }, [close]);

  useEffect(() => {
    alive.current = true;
    const refresh = () => window.wanigan.sessions.list()
      .then((live) => {
        if (!alive.current) return;
        sessions.current = Object.fromEntries(live.map((s) => [s.id, s] as const));
      })
      .catch(() => { /* a name is a courtesy; the event still stands without one */ });
    void refresh();

    const off = window.wanigan.on.sessionEvent((event: SessionEvent) => {
      if (!alive.current) return;
      // PreToolUse is the moment it was sent; the Post row would draw it twice.
      if (event.event !== 'PreToolUse' || event.toolName !== 'SendMessage') return;
      const { to, label } = split(event.summary);
      const from = nameOf(event.sessionId);
      const next = cast(stageRef.current, from, to);
      setStage(next);
      setLines((current) => [
        ...current.slice(-(MAX_KEPT - 1)),
        { id: String(event.id), at: event.at, from, to, label, side: next.speaker },
      ]);
      // The ball is now in the other court, for a while.
      setAwaiting(next.speaker === 'left' ? 'right' : 'left');
      clear(replyWindow);
      replyWindow.current = window.setTimeout(() => {
        replyWindow.current = null;
        if (alive.current) setAwaiting(null);
      }, REPLY_WINDOW_MS);
      clear(leave);
      setPhase('open');
      arm();
      void refresh();
    });

    return () => {
      alive.current = false;
      off();
      clear(settle); clear(replyWindow); clear(leave);
    };
  }, [arm, nameOf]);

  const shown = useMemo(() => lines.slice(-MAX_LINES), [lines]);
  const hidden = lines.length - shown.length;

  if (phase === 'hidden' || !stage || !shown.length) return null;

  const listener: Side = stage.speaker === 'left' ? 'right' : 'left';

  return (
    <aside
      className={`chatter${phase === 'leaving' ? ' is-leaving' : ''}`}
      role="log"
      aria-live="polite"
      aria-label="Messages between your sessions"
      onMouseEnter={() => { held.current = true; }}
      onMouseLeave={() => { held.current = false; }}
      onFocus={() => { held.current = true; }}
      onBlur={() => { held.current = false; }}
    >
      <header className="chatter-head">
        <span className="chatter-title">Your sessions are talking</span>
        {/* Keyed on the count so the badge bumps once per real arrival. */}
        <span className="chatter-n" key={lines.length}>{lines.length}</span>
        <button className="chatter-x" onClick={close} aria-label="Dismiss this exchange">
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      {/* The scene. Keyed on the tick so every arrival replays the crossing:
          the speaker squashes, the packet flies, the listener bobs. It is
          aria-hidden because the thread below says the same thing in words. */}
      <div
        key={stage.tick}
        className={`chatter-stage speaks-${stage.speaker}${awaiting ? ` awaits-${awaiting}` : ''}`}
        aria-hidden="true"
      >
        <Character side="left" who={stage.left} speaking={stage.speaker === 'left'} listening={listener === 'left'} waiting={awaiting === 'left'} />
        <span className="chatter-wire">
          <span className="chatter-packet" />
        </span>
        <Character side="right" who={stage.right} speaking={stage.speaker === 'right'} listening={listener === 'right'} waiting={awaiting === 'right'} />
      </div>

      <ol className="chatter-lines">
        {shown.map((line) => (
          <li className={`chatter-line side-${line.side}`} key={line.id}>
            <span className="chatter-bubble">
              <span className="chatter-who">{line.from}</span>
              {line.label
                ? <span className="chatter-said">{line.label}</span>
                : <span className="chatter-quiet">sent a message with no label</span>}
              <span className="sr-only">{` to ${line.to}`}</span>
            </span>
          </li>
        ))}
      </ol>

      <p className="chatter-foot">
        {hidden > 0 && <span className="chatter-more">{hidden} earlier · </span>}
        {awaiting && <span className="chatter-more">{(awaiting === 'left' ? stage.left : stage.right).name} has a message waiting · </span>}
        Wanigan sees the label a sender gives a message, never the message.
      </p>
    </aside>
  );
}

function Character({ side, who, speaking, listening, waiting }: {
  side: Side; who: Party; speaking: boolean; listening: boolean; waiting: boolean;
}) {
  const state = speaking ? ' is-speaking' : listening ? ' is-listening' : '';
  return (
    <span className={`chatter-actor actor-${side}${state}`}>
      <span className="chatter-face">
        <span className="chatter-eyes"><span className="chatter-eye" /><span className="chatter-eye" /></span>
        <span className="chatter-initial">{who.initial}</span>
      </span>
      {/* Only while a message sent to them has not been answered; it stops on
          its own when the window closes. Dots are the idiom everyone reads as
          "their turn", which is exactly the true thing here. */}
      {waiting && (
        <span className="chatter-typing">
          <span className="chatter-dot" /><span className="chatter-dot" /><span className="chatter-dot" />
        </span>
      )}
      <span className="chatter-actor-name">{who.name}</span>
    </span>
  );
}
