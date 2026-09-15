import { asksFor, recordAsks, tickAsk } from './ask-items';

/**
 * The wiring for the review-depth helpers (helper sweep P7): one start function
 * and one IPC registrar, so index.ts carries two calls rather than a block per
 * feature. Every renderer argument arrives as `unknown` and is validated in the
 * module that owns it.
 */

type Handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void;

let started = false;

export function startDepthServices(): void {
  if (started) return;
  started = true;
}

export function registerDepthIpc(handle: Handle): void {
  handle('depth:asksRecord', (sessionId: unknown, text: unknown) => recordAsks(sessionId, text, 'composer'));
  handle('depth:asksList', (sessionId: unknown) => asksFor(sessionId));
  handle('depth:asksTick', (itemId: unknown, ticked: unknown) => tickAsk(itemId, ticked));
}

/** The phone's prompt path: the same record, marked as sent from the phone. */
export function recordPhoneAsks(sessionId: string, prompt: string): void {
  try { recordAsks(sessionId, prompt, 'phone'); } catch { /* the prompt was written; the checklist is extra */ }
}
