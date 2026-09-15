import { asksFor, recordAsks, tickAsk } from './ask-items';
import { loopBudgetMeasure, setLoopBudgets } from './control';
import { maintainabilityFor } from './maintainability';
import { onHookInput } from './hooks';
import { observeFileRefs, sessionFiles } from './session-files';
import { agentGitMarks } from './agent-git';
import { compactionsFor } from './compactions';
import { promotedPaths, setScratchPromotion } from './scratch';
import { scratchReason } from '../shared/scratch-files';
import { db } from './db';
import { historyRewriteAskSettings, setHistoryRewriteAsk } from './policy';

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
  handle('depth:historyRewriteAsk', () => historyRewriteAskSettings());
  handle('depth:setHistoryRewriteAsk', (projectId: unknown, on: unknown) => setHistoryRewriteAsk(projectId, on));
  handle('depth:promoteScratch', (sessionId: unknown, rel: unknown, on: unknown) => {
    const id = idArg(sessionId, 'session');
    const row = db().prepare('SELECT project_id FROM session_log WHERE id = ?').get(id) as { project_id: string | null } | undefined;
    return setScratchPromotion(row?.project_id ?? null, rel, on);
  });
  handle('depth:compactions', (sessionId: unknown) => compactionsFor(sessionId));
  handle('depth:agentGit', (root: unknown) => agentGitMarks(options.gitRoot(root)));
  handle('depth:sessionFiles', (sessionId: unknown) => sessionFiles(sessionId));
  handle('depth:maintainability', (sessionId: unknown) => {
    const id = idArg(sessionId, 'session');
    const row = db().prepare('SELECT project_id FROM session_log WHERE id = ?').get(id) as { project_id: string | null } | undefined;
    const promoted = promotedPaths(row?.project_id ?? null);
    // Scratch paths are not the change under review, so the heuristics skip them and say so.
    return maintainabilityFor(id, { exclude: (rel) => !promoted.has(rel) && scratchReason(rel) !== null });
  });
  handle('depth:loopMeasure', (docketId: unknown) => loopBudgetMeasure(idArg(docketId, 'goal')));
}

/** The phone's prompt path: the same record, marked as sent from the phone. */
export function recordPhoneAsks(sessionId: string, prompt: string): void {
  try { recordAsks(sessionId, prompt, 'phone'); } catch { /* the prompt was written; the checklist is extra */ }
}
