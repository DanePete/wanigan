import type { BrowserWindow } from 'electron';
import * as attention from './attention';
import * as hooks from './hooks';
import * as notify from './notify';
import { knownLimits } from './usage';
import { listSessions } from './sessions';
import { recordOperatorAction } from './operator-actions';
import {
  setStatusChecksEnabled, sourcesFor, startProviderStatusPoller, statusReport, stopProviderStatusPoller,
} from './provider-incidents';
import * as triage from './session-triage';
import { QUOTA_RESUMED } from '../shared/attention-rules';
import { ERROR_WINDOW_MS } from './attention';

/**
 * The helper sweep's attention features, wired once.
 *
 * index.ts is the file every package touches, so the wiring lives here and
 * index.ts calls three functions: register the channels, start the services
 * with the window, stop them. Every channel validates its own arguments in the
 * module it calls — the renderer is untrusted here as everywhere.
 */

type Handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void;

/** A reply that arrived while no window was open, held for the next one. */
const heldReplies: { sessionId: string; text: string; at: number }[] = [];
const HELD_MAX = 20;
const REPLY_MAX = 4000;

export function registerHelperAttentionIpc(handle: Handle): void {
  handle('helper:snooze', (sessionId: unknown, preset: unknown) => triage.snoozeSession(sessionId, preset));
  handle('helper:unsnooze', (sessionId: unknown) => triage.unsnoozeSession(sessionId));
  handle('helper:markUnread', (sessionId: unknown) => triage.markSessionUnread(sessionId));
  handle('helper:sessionLeft', (sessionId: unknown) => triage.sessionLeft(sessionId));
  handle('helper:sessionReturned', (sessionId: unknown) => triage.sessionReturned(sessionId));
  handle('helper:reopenClosed', () => triage.reopenClosedTab());
  handle('helper:resumeCheck', (sessionId: unknown) => triage.resumeCheck(sessionId));
  handle('helper:resumeAsFork', (sessionId: unknown) => triage.resumeAsFork(sessionId));
  handle('helper:limitOffer', (sessionId: unknown, operatorSays: unknown) => triage.limitResumeOffer(sessionId, operatorSays === true));
  handle('helper:armResume', (sessionId: unknown, operatorSays: unknown) => triage.armResumeAtReset(sessionId, operatorSays === true));
  handle('helper:cancelResume', (id: unknown) => triage.cancelResumeAtReset(id));
  handle('helper:resumes', () => triage.resumesAtReset());
  handle('helper:statusReport', () => statusReport());
  handle('helper:setStatusChecks', (on: unknown) => {
    if (typeof on !== 'boolean') throw new Error('Status checks are either on or off.');
    return setStatusChecksEnabled(on);
  });
  // The renderer put a retry line in a composer draft. The draft is the
  // operator's; this records that it was offered, not what it said.
  handle('helper:denialRetryDrafted', (sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !listSessions().some((s) => s.id === sessionId)) return false;
    recordOperatorAction(sessionId, 'denial-retry-drafted', null);
    return true;
  });
  handle('helper:takeReplies', () => heldReplies.splice(0, heldReplies.length));
}

let stopQuotaListener: (() => void) | null = null;

export function startHelperAttentionServices(liveWindow: () => BrowserWindow | null, smoke: boolean): void {
  attention.setLimitReadingSource(() => knownLimits());

  stopQuotaListener?.();
  stopQuotaListener = hooks.onHookEvent((e) => {
    if (e.event !== 'Notification' || e.detail !== QUOTA_RESUMED) return;
    const s = listSessions().find((x) => x.id === e.sessionId);
    notify.announceLimitResumed(e.sessionId, e.id, s?.projectName ?? null, e.summary);
  });

  notify.setNotificationReplySink((sessionId, raw) => {
    const text = raw.slice(0, REPLY_MAX);
    recordOperatorAction(sessionId, 'notification-reply-drafted', `${text.length} characters`);
    const w = liveWindow();
    if (w && !w.isDestroyed()) {
      w.webContents.send('helper:notificationReply', { sessionId, text });
      return;
    }
    heldReplies.push({ sessionId, text, at: Date.now() });
    if (heldReplies.length > HELD_MAX) heldReplies.shift();
  });
  notify.setNotificationActionSink((sessionId) => recordOperatorAction(sessionId, 'notification-opened', null));

  // No network and no launches under the offline smoke suite; both are
  // exercised there through their pure halves and injected state instead.
  if (smoke) return;
  startProviderStatusPoller(() => {
    const now = Date.now();
    const relevant = listSessions().filter((s) => s.status !== 'exited'
      || (s.endedAt !== null && now - s.endedAt <= ERROR_WINDOW_MS && s.exitCode !== 0));
    return { sources: sourcesFor(relevant) };
  });
  triage.startResumeScheduler(() => { /* createSession broadcasts the new session itself */ });
}

export function stopHelperAttentionServices(): void {
  stopQuotaListener?.();
  stopQuotaListener = null;
  notify.setNotificationReplySink(null);
  notify.setNotificationActionSink(null);
  attention.setLimitReadingSource(null);
  stopProviderStatusPoller();
  triage.stopResumeScheduler();
}
