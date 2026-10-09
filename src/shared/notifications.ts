// Which needs deserve an announcement, where, and what it says. Pure, so it is
// tested without Electron; the main process and the window only do what this
// returns.
//
// A need is announced at most once natively (a macOS notification, while
// Wanigan is not in front) and at most once in the window (an alert card, while
// it is). It counts as announced only once it was actually shown: a need that
// arrived while you were looking at the app is not silently written off, and
// when you leave with it still open it is announced natively then.
import type { Need, NeedKind } from './model.ts';
import type { NotifyLevel } from './settings.ts';

/** A need's identity across refreshes: a new permission request is a new need. */
export const needKey = (n: Need): string => `${n.kind}:${n.sessionId ?? ''}:${n.cardId ?? ''}:${n.since}`;

/** Kinds that interrupt you inside the window. A finished turn or a quiet session waits in Needs you. */
export const ALERT_KINDS: ReadonlySet<NeedKind> = new Set(['permission', 'overlap', 'review', 'failed', 'interrupted', 'question', 'limit']);
/** Kinds whose alert stays until it is handled or dismissed; the rest fade. */
export const URGENT_KINDS: ReadonlySet<NeedKind> = new Set(['permission', 'failed', 'interrupted', 'limit']);
/** How long a non-urgent alert card stays, unless it is being read. */
export const ALERT_FADE_MS = 12_000;
/** More fresh needs than this at once become one summary notification. */
export const NATIVE_BURST = 3;

export interface Announced {
  /** Null until the first look, which only primes: what was open when Wanigan started is not news. */
  native: ReadonlySet<string> | null;
  /** Shown as an alert card, on screen when it arrived, or a quiet kind that arrived while the window was in front. */
  window: ReadonlySet<string>;
  /** Dismissed or opened from an alert: the owner has it. */
  dismissed: ReadonlySet<string>;
}

/** Whether the owner's notification setting lets this kind of need be announced at all. */
export function allows(level: NotifyLevel, kind: NeedKind): boolean {
  return level === 'all' || (level === 'urgent' && URGENT_KINDS.has(kind));
}

export const nothingAnnounced = (): Announced => ({ native: null, window: new Set(), dismissed: new Set() });

export interface Plan {
  /** Show these as native notifications now; mark them once shown. */
  native: Need[];
  /** Offer these to the window as alert cards; it says which it showed. */
  window: Need[];
  /** The state after this look: primed, pruned of needs that closed, and quiet kinds the window saw. */
  state: Announced;
}

/**
 * What to announce, given what is open and whether Wanigan is in front.
 * Leaving the window re-announces natively what is still open and was only
 * ever shown in it; a dismissed alert is never announced again. A need the
 * owner's setting keeps quiet is settled as it arrives, so turning
 * notifications back on does not replay everything already open.
 */
export function plan(state: Announced, needs: readonly Need[], focused: boolean, level: NotifyLevel = 'all'): Plan {
  const open = new Set(needs.map(needKey));
  const keep = (set: ReadonlySet<string>): Set<string> => new Set([...set].filter((k) => open.has(k)));
  if (state.native === null) {
    return { native: [], window: [], state: { native: new Set(open), window: new Set(open), dismissed: new Set() } };
  }
  const native = keep(state.native);
  const window = keep(state.window);
  const dismissed = keep(state.dismissed);
  for (const n of needs) {
    if (allows(level, n.kind)) continue;
    native.add(needKey(n));
    window.add(needKey(n));
  }
  const fresh = (n: Need): boolean => !native.has(needKey(n)) && !dismissed.has(needKey(n));

  if (focused) {
    const offer = needs.filter((n) => ALERT_KINDS.has(n.kind) && fresh(n) && !window.has(needKey(n)));
    // A finished turn arriving while you look at the app has been seen; it is not re-announced when you leave.
    for (const n of needs) if (!ALERT_KINDS.has(n.kind)) window.add(needKey(n));
    return { native: [], window: offer, state: { native, window, dismissed } };
  }
  const show = needs.filter((n) => fresh(n) && (ALERT_KINDS.has(n.kind) || !window.has(needKey(n))));
  return { native: show, window: [], state: { native, window, dismissed } };
}

/** Record that these were shown natively. */
export function markNative(state: Announced, needs: readonly Need[]): Announced {
  return { ...state, native: new Set([...(state.native ?? []), ...needs.map(needKey)]) };
}

/** Record that the window accounted for these keys (shown as a card, or already on screen). */
export function markWindow(state: Announced, keys: readonly string[]): Announced {
  return { ...state, window: new Set([...state.window, ...keys]) };
}

export function markDismissed(state: Announced, keys: readonly string[]): Announced {
  return { ...state, dismissed: new Set([...state.dismissed, ...keys]) };
}

/**
 * Native notifications for one look: each need by itself, or, past the burst,
 * the two most urgent and one line for the rest. Every need passed in is
 * announced by what this returns.
 */
export function nativeBatch(needs: readonly Need[]): { single: Need[]; rest: { title: string; body: string } | null } {
  if (needs.length <= NATIVE_BURST) return { single: [...needs], rest: null };
  const single = needs.slice(0, NATIVE_BURST - 1);
  const others = needs.slice(NATIVE_BURST - 1);
  const projects = [...new Set(others.map((n) => n.projectName))];
  return {
    single,
    rest: {
      title: `${others.length} more need you`,
      body: projects.length <= 3 ? `In ${projects.join(', ')}` : `In ${projects.slice(0, 2).join(', ')} and ${projects.length - 2} more projects`,
    },
  };
}

/** Alert keys sent back by the window. It is untrusted input: strings only, bounded. */
export function alertKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 400).slice(0, 500);
}

/** What the window has on screen, as far as alerts care. */
export interface Viewing {
  route: 'needs' | 'project' | 'session' | 'other';
  projectKey: string | null;
  sessionId: string | null;
  /** The card open in the drawer. */
  cardKey: string | null;
}

/**
 * Whether a need is already in front of you. Needs you shows every need; a
 * project's views show its own; a session shows itself; an open card shows itself.
 */
export function onScreen(n: Need, v: Viewing): boolean {
  if (v.route === 'needs') return true;
  if (v.cardKey && n.cardKey === v.cardKey) return true;
  if (v.route === 'session') return !!n.sessionId && n.sessionId === v.sessionId;
  if (v.route === 'project') return n.projectKey === v.projectKey;
  return false;
}

/** Where a need is answered, as an app route. */
export function needRoute(n: Need): string {
  if (n.kind === 'review' || n.kind === 'question') {
    return `#/p/${encodeURIComponent(n.projectKey)}/board?card=${encodeURIComponent(n.cardKey ?? '')}`;
  }
  return n.sessionId ? `#/p/${encodeURIComponent(n.projectKey)}/s/${encodeURIComponent(n.sessionId)}` : '#/needs';
}

export function notificationFor(n: Need): { title: string; body: string } {
  const what = n.cardKey ?? n.title;
  switch (n.kind) {
    case 'permission': return { title: `${what} needs permission`, body: n.detail ?? n.title };
    case 'starting': return { title: `${what} has not started`, body: n.detail ?? n.title };
    case 'review': return { title: `${what} is ready for review`, body: n.title };
    case 'question': return { title: `Question on ${what}`, body: n.detail ?? n.title };
    case 'failed': return { title: `${what}: session failed`, body: n.detail ?? n.title };
    case 'interrupted': return { title: `${what}: session interrupted`, body: n.detail ?? n.title };
    case 'waiting': return { title: `${what} finished its turn`, body: n.title };
    case 'overlap': return { title: `Two sessions edited ${n.title}`, body: n.detail ?? n.title };
    case 'quiet': return { title: `${what} has gone quiet`, body: n.detail ?? n.title };
    case 'limit': return { title: `${what} hit its usage limit`, body: n.detail ?? n.title };
  }
}
