// Two agents talking, on screen, while it happens, as two characters.
//
// Claude Code agents can message each other (SendMessage), and every word of it
// happens in a terminal nobody is looking at. The owner's model of the work is
// "these agents are working separately"; the moment two of them coordinate, that
// model is wrong and nothing says so. This card does, as a small scene rather
// than a log: the two stand facing each other, the message visibly crosses the
// wire, the speaker squashes to talk and the listener bobs to hear, and the
// exchange gathers beneath them as bubbles.
//
// What it shows is what the core recorded: who sent, who it went to, and the
// sender's own short label for it. Never the message (see shared/chatter.ts).
//
// Ported from Wanigan 1's SessionChatter, with its one bug fixed: the label and
// the recipient now come apart where they were joined, in one shared encoding.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectSummary } from '@shared/model';
import type { Events } from '@shared/protocol';
import { bridge } from '../lib/api';
import { href } from '../lib/router';
import { Icon } from './icons';

/** Quiet for this long and the exchange is over, so the card leaves by itself. */
const SETTLE_MS = 16_000;
/** After this the listener's waiting dots stop: silence is an answer too. */
const REPLY_WINDOW_MS = 24_000;
/** Time given to the leaving animation before the card unmounts. */
const LEAVE_MS = 300;
/** A conversation, not a log. */
const MAX_LINES = 5;
const MAX_KEPT = 40;

type Side = 'left' | 'right';

interface Party {
  name: string;
  initial: string;
  /** The session to open when the character is clicked: only a Wanigan session has one. */
  link: string | null;
}

interface Line {
  id: number;
  from: string;
  to: string;
  label: string | null;
  side: Side;
  link: string | null;
}

interface Stage {
  left: Party;
  right: Party;
  /** Who spoke last, so the packet flies the right way and the other one listens. */
  speaker: Side;
  /** Bumped per message; keys the scene so its animations replay. */
  tick: number;
}

function party(name: string, link: string | null): Party {
  const letter = name.trim().replace(/^[^\p{L}\p{N}]+/u, '').charAt(0);
  return { name, initial: (letter || '?').toUpperCase(), link };
}

/**
 * Two parties keep their places for as long as they keep talking to each other;
 * a third walks on and the stage is re-cast around them.
 */
function cast(stage: Stage | null, from: Party, to: Party): Stage {
  if (stage) {
    if (from.name === stage.left.name && to.name === stage.right.name) return { ...stage, left: { ...stage.left, link: stage.left.link ?? from.link }, speaker: 'left', tick: stage.tick + 1 };
    if (from.name === stage.right.name && to.name === stage.left.name) return { ...stage, right: { ...stage.right, link: stage.right.link ?? from.link }, speaker: 'right', tick: stage.tick + 1 };
  }
  return { left: from, right: to, speaker: 'left', tick: (stage?.tick ?? 0) + 1 };
}

/**
 * Who said it and to whom, by name. A subagent is named as itself; its "main"
 * is the session it lives in, so a reply reads as one party answering another
 * rather than the session talking to itself.
 */
function parties(e: Events['chatter'], link: string | null): { from: Party; to: Party } {
  const session = e.from || 'A session';
  const from = party(e.agent ?? session, link);
  const toName = e.agent && (e.to === 'main' || !e.to) ? session : (e.to ?? 'another agent');
  return { from, to: party(toName, e.agent && toName === session ? link : null) };
}

export function Chatter({ projects }: { projects: ProjectSummary[] | undefined }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [stage, setStage] = useState<Stage | null>(null);
  const [phase, setPhase] = useState<'hidden' | 'open' | 'leaving'>('hidden');
  /** The side whose reply is awaited, or null once they answer or the window closes. */
  const [awaiting, setAwaiting] = useState<Side | null>(null);

  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replyWindow = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const stageRef = useRef<Stage | null>(null);
  stageRef.current = stage;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const nextId = useRef(1);

  const clear = (ref: { current: ReturnType<typeof setTimeout> | null }): void => {
    if (ref.current !== null) { clearTimeout(ref.current); ref.current = null; }
  };

  const close = useCallback(() => {
    clear(settle);
    clear(replyWindow);
    setAwaiting(null);
    setPhase('leaving');
    clear(leave);
    // A timer, not animationend: under reduced motion the animation is all but
    // zero-length, and a card that never hears its end can't be read or dismissed.
    leave.current = setTimeout(() => {
      leave.current = null;
      setPhase('hidden');
      setLines([]);
      setStage(null);
    }, LEAVE_MS);
  }, []);

  const arm = useCallback(() => {
    clear(settle);
    settle.current = setTimeout(() => {
      settle.current = null;
      // Reading counts as using it: a card that vanished mid-sentence teaches
      // people to screenshot it instead of reading it.
      if (held.current) { arm(); return; }
      close();
    }, SETTLE_MS);
  }, [close]);

  useEffect(() => {
    const off = bridge().on((event, data) => {
      if (event !== 'chatter') return;
      const e = data as Events['chatter'];
      const key = projectsRef.current?.find((p) => p.id === e.projectId)?.key;
      const link = key ? href({ name: 'session', projectKey: key, sessionId: e.sessionId }) : null;
      const { from, to } = parties(e, link);
      const next = cast(stageRef.current, from, to);
      stageRef.current = next;
      setStage(next);
      setLines((current) => [
        ...current.slice(-(MAX_KEPT - 1)),
        { id: nextId.current++, from: from.name, to: to.name, label: e.label, side: next.speaker, link },
      ]);
      // The ball is in the other court, for a while.
      setAwaiting(next.speaker === 'left' ? 'right' : 'left');
      clear(replyWindow);
      replyWindow.current = setTimeout(() => { replyWindow.current = null; setAwaiting(null); }, REPLY_WINDOW_MS);
      clear(leave);
      setPhase('open');
      arm();
    });
    return () => {
      off();
      clear(settle);
      clear(replyWindow);
      clear(leave);
    };
  }, [arm]);

  const shown = useMemo(() => lines.slice(-MAX_LINES), [lines]);
  const earlier = lines.length - shown.length;

  if (phase === 'hidden' || !stage || !shown.length) return null;
  const listener: Side = stage.speaker === 'left' ? 'right' : 'left';
  const waitingOn = awaiting ? (awaiting === 'left' ? stage.left : stage.right) : null;

  return (
    <aside
      className={`chatter${phase === 'leaving' ? ' is-leaving' : ''}`}
      role="log"
      aria-live="polite"
      aria-label="Messages between your agents"
      onMouseEnter={() => { held.current = true; }}
      onMouseLeave={() => { held.current = false; }}
      onFocus={() => { held.current = true; }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) held.current = false; }}
    >
      <header className="chatter-head">
        <span className="chatter-title">Your agents are talking</span>
        {/* Keyed on the count so the badge bumps once per arrival. */}
        <span className="chatter-n" key={lines.length}>{lines.length}</span>
        <button type="button" className="chatter-x" onClick={close} aria-label="Dismiss this exchange" title="Dismiss">
          <Icon name="close" size={14} />
        </button>
      </header>

      {/* Keyed on the tick so every arrival replays the crossing. Hidden from
          assistive tech: the thread below says the same thing in words. */}
      <div key={stage.tick} className={`chatter-stage speaks-${stage.speaker}`} aria-hidden="true">
        <Character side="left" who={stage.left} speaking={stage.speaker === 'left'} listening={listener === 'left'} waiting={awaiting === 'left'} />
        <span className="chatter-wire"><span className="chatter-packet" /></span>
        <Character side="right" who={stage.right} speaking={stage.speaker === 'right'} listening={listener === 'right'} waiting={awaiting === 'right'} />
      </div>

      <ol className="chatter-lines">
        {shown.map((line) => (
          <li className={`chatter-line side-${line.side}`} key={line.id}>
            <span className="chatter-bubble">
              {line.link
                ? <a className="chatter-who" href={line.link} title={`Open ${line.from}`}>{line.from}</a>
                : <span className="chatter-who">{line.from}</span>}
              {line.label
                ? <span className="chatter-said">{line.label}</span>
                : <span className="chatter-quiet">sent a message with no label</span>}
              <span className="visually-hidden">{` to ${line.to}`}</span>
            </span>
          </li>
        ))}
      </ol>

      <p className="chatter-foot">
        {earlier > 0 ? <span className="chatter-more">{earlier} earlier · </span> : null}
        {waitingOn ? <span className="chatter-more">{waitingOn.name} has a message waiting · </span> : null}
        Wanigan sees the label a sender gives a message, never the message.
      </p>
    </aside>
  );
}

function Character({ side, who, speaking, listening, waiting }: {
  side: Side;
  who: Party;
  speaking: boolean;
  listening: boolean;
  waiting: boolean;
}) {
  const state = speaking ? ' is-speaking' : listening ? ' is-listening' : '';
  const face = (
    <span className="chatter-face">
      <span className="chatter-eyes"><span className="chatter-eye" /><span className="chatter-eye" /></span>
      <span className="chatter-initial">{who.initial}</span>
    </span>
  );
  return (
    <span className={`chatter-actor actor-${side}${state}`}>
      {/* The scene is hidden from assistive tech, so its link is for the pointer
          only; the same session is a real link in the thread below. */}
      {who.link ? <a className="chatter-face-link" href={who.link} tabIndex={-1} title={`Open ${who.name}`}>{face}</a> : face}
      {/* Only while a message sent to them has not been answered. Dots are the
          idiom everyone reads as "their turn", which is the true thing here. */}
      {waiting ? (
        <span className="chatter-typing"><span className="chatter-dot" /><span className="chatter-dot" /><span className="chatter-dot" /></span>
      ) : null}
      <span className="chatter-actor-name">{who.name}</span>
    </span>
  );
}
