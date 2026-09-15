import type { Attention } from '@shared/types';
import { appendToComposerDraft } from './Composer';

/**
 * The two things an attention item can do besides open its session, shared by
 * the strip in Sessions and the inspector in Fleet so both mean the same thing.
 */

/** Asks a mounted Sessions view to show one session's timeline. */
export const OPEN_TIMELINE_EVENT = 'wanigan:open-timeline';

const PANE_KEY = 'wanigan.rail.pane';
const RAIL_KEY = 'wanigan.code';

/**
 * Put a session's Timeline in front of the operator.
 *
 * Written through the same two stored preferences Sessions reads when it
 * mounts — which pane each session's side panel shows, and whether the panel
 * is open — so the request survives a route change from Fleet, and announced
 * as an event for a Sessions view that is already mounted and will not re-read
 * them.
 */
export function openTimeline(sessionId: string, eventId?: number): void {
  /* ── helper sweep · P7 depth ── a specific row to scroll to, for a view that mounts after the event. */
  pendingFocus = typeof eventId === 'number' ? { sessionId, eventId, at: Date.now() } : null;
  try {
    const raw = localStorage.getItem(PANE_KEY);
    const map = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    localStorage.setItem(PANE_KEY, JSON.stringify({ ...map, [sessionId]: 'timeline' }));
    localStorage.setItem(RAIL_KEY, '1');
  } catch { /* storage can be blocked; the event below still reaches a mounted view */ }
  window.dispatchEvent(new CustomEvent<{ sessionId: string; eventId?: number }>(OPEN_TIMELINE_EVENT, { detail: { sessionId, eventId } }));
}

/* ── helper sweep · P7 depth ── */
let pendingFocus: { sessionId: string; eventId: number; at: number } | null = null;

/**
 * The timeline row a just-mounted Sessions view should scroll to, once. A
 * request older than a minute is dropped: it was for a navigation that has
 * already happened or been abandoned.
 */
export function takePendingTimelineFocus(sessionId: string): number | null {
  const p = pendingFocus;
  if (!p || p.sessionId !== sessionId || Date.now() - p.at > 60_000) return null;
  pendingFocus = null;
  return p.eventId;
}
/* ── end helper sweep · P7 depth ── */

/**
 * Put the retry line in the session's composer, unsent, and record that it
 * was offered. Returns false when the verdict carries no denial to retry.
 */
export function draftDenialRetry(a: Attention): boolean {
  const denial = a.helper?.denial;
  if (!denial) return false;
  appendToComposerDraft(a.sessionId, denial.retryDraft,
    'The retry line is in your draft. Nothing is sent until you press Send.');
  void window.wanigan.helper.denialRetryDrafted(a.sessionId).catch(() => {});
  return true;
}

/** "3:05 PM" for a reset or a snooze end; the date too when it is not today. */
export function clockAt(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
