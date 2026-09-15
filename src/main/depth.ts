import { asksFor, recordAsks, tickAsk } from './ask-items';
import { loopBudgetMeasure, setLoopBudgets } from './control';
import { maintainabilityFor } from './maintainability';
import { onHookInput } from './hooks';
import { observeFileRefs, sessionFiles } from './session-files';
import { agentGitMarks } from './agent-git';

/**
 * The wiring for the review-depth helpers (helper sweep P7): one start function
 * and one IPC registrar, so index.ts carries two calls rather than a block per
 * feature. Every renderer argument arrives as `unknown` and is validated in the
 * module that owns it.
 */

function idArg(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:.-]{1,200}$/.test(value)) throw new Error(`That is not a ${what} Wanigan knows.`);
  return value;
}

type Handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void;

let started = false;

export function startDepthServices(): void {
  if (started) return;
  started = true;
  // After the hook has been answered, like every other input observer.
  onHookInput((stored, input, cwd) => { observeFileRefs(stored, input, cwd); });
}

/** What index.ts supplies: the managed-root check every Git view channel goes through. */
export type DepthIpcOptions = { gitRoot: (root: unknown) => string };

export function registerDepthIpc(handle: Handle, options: DepthIpcOptions): void {
  handle('depth:asksRecord', (sessionId: unknown, text: unknown) => recordAsks(sessionId, text, 'composer'));
  handle('depth:asksList', (sessionId: unknown) => asksFor(sessionId));
  handle('depth:asksTick', (itemId: unknown, ticked: unknown) => tickAsk(itemId, ticked));
  handle('depth:setLoopBudgets', (docketId: unknown, budgets: unknown) => setLoopBudgets(idArg(docketId, 'goal'), budgets));
  handle('depth:agentGit', (root: unknown) => agentGitMarks(options.gitRoot(root)));
  handle('depth:sessionFiles', (sessionId: unknown) => sessionFiles(sessionId));
  handle('depth:maintainability', (sessionId: unknown) => maintainabilityFor(sessionId));
  handle('depth:loopMeasure', (docketId: unknown) => loopBudgetMeasure(idArg(docketId, 'goal')));
}

/** The phone's prompt path: the same record, marked as sent from the phone. */
export function recordPhoneAsks(sessionId: string, prompt: string): void {
  try { recordAsks(sessionId, prompt, 'phone'); } catch { /* the prompt was written; the checklist is extra */ }
}
