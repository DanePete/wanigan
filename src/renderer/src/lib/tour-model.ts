// The tours' pure parts, with no imports so they test under plain Node: what
// the owner has already seen, which step comes next when a step's target is
// not on the screen, and where a step's card goes beside its target.

/** Where the tours' state is kept: a per-viewer convenience, like the panels' sizes. */
export const TOURS_KEY = 'wanigan.tours';

export interface TourState {
  /** The owner turned first-visit tours off (Settings › Appearance). Replaying one still works. */
  off: boolean;
  /** Tours taken to the end or ended early: never offered again, always replayable. */
  seen: string[];
  /** Tours whose first-visit offer was put away with Not now: never offered again either. */
  dismissed: string[];
}

export const NO_TOURS_SEEN: TourState = { off: false, seen: [], dismissed: [] };

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64))].slice(0, 200) : [];

/** What was stored, read defensively: anything unreadable is "nothing seen yet", never an error. */
export function readTourState(raw: string | null): TourState {
  if (!raw) return { ...NO_TOURS_SEEN };
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (!v || typeof v !== 'object') return { ...NO_TOURS_SEEN };
    return { off: v.off === true, seen: ids(v.seen), dismissed: ids(v.dismissed) };
  } catch {
    return { ...NO_TOURS_SEEN };
  }
}

export function writeTourState(s: TourState): string {
  return JSON.stringify({ off: s.off, seen: ids(s.seen), dismissed: ids(s.dismissed) });
}

export function markSeen(s: TourState, id: string): TourState {
  return s.seen.includes(id) ? s : { ...s, seen: [...s.seen, id] };
}

export function markDismissed(s: TourState, id: string): TourState {
  return s.dismissed.includes(id) ? s : { ...s, dismissed: [...s.dismissed, id] };
}

/** Whether a tour may offer itself on a first visit: on, never seen, never put away. */
export function mayOffer(s: TourState, id: string): boolean {
  return !s.off && !s.seen.includes(id) && !s.dismissed.includes(id);
}

/**
 * The next step to show from `from`, going `dir` (1 forward, -1 back), over steps
 * `shown(i)` says can be shown (no target, or its target is on the screen). -1 when
 * none is left that way: going forward that ends the tour; going back it stays put.
 */
export function nextShown(count: number, from: number, dir: 1 | -1, shown: (i: number) => boolean): number {
  for (let i = from + dir; i >= 0 && i < count; i += dir) if (shown(i)) return i;
  return -1;
}

export interface Rect { left: number; top: number; width: number; height: number }
export type Side = 'top' | 'bottom' | 'left' | 'right';
export interface Placed { left: number; top: number; side: Side | 'center' }

const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * Where a step's card goes: on the preferred side of its target if it fits, else
 * the opposite side, else whichever side has the most room; always inside the
 * window by `edge`. With no target the card is centred.
 */
export function placeCard(target: Rect | null, card: { width: number; height: number }, view: { width: number; height: number }, prefer: Side = 'bottom', gap = 12, edge = 12): Placed {
  const clampX = (x: number): number => Math.max(edge, Math.min(x, view.width - card.width - edge));
  const clampY = (y: number): number => Math.max(edge, Math.min(y, view.height - card.height - edge));
  if (!target) return { left: clampX((view.width - card.width) / 2), top: clampY((view.height - card.height) / 2), side: 'center' };
  const room: Record<Side, number> = {
    top: target.top - gap - edge,
    bottom: view.height - (target.top + target.height) - gap - edge,
    left: target.left - gap - edge,
    right: view.width - (target.left + target.width) - gap - edge,
  };
  const need = (side: Side): number => (side === 'top' || side === 'bottom' ? card.height : card.width);
  const fits = (side: Side): boolean => room[side] >= need(side);
  const side: Side = fits(prefer) ? prefer : fits(opposite[prefer]) ? opposite[prefer]
    : (Object.keys(room) as Side[]).reduce((a, b) => (room[b] - need(b) > room[a] - need(a) ? b : a));
  const midX = target.left + target.width / 2 - card.width / 2;
  const midY = target.top + target.height / 2 - card.height / 2;
  switch (side) {
    case 'top': return { left: clampX(midX), top: clampY(target.top - gap - card.height), side };
    case 'bottom': return { left: clampX(midX), top: clampY(target.top + target.height + gap), side };
    case 'left': return { left: clampX(target.left - gap - card.width), top: clampY(midY), side };
    case 'right': return { left: clampX(target.left + target.width + gap), top: clampY(midY), side };
  }
}
