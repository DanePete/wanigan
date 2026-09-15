/**
 * helper sweep · P5 runtime — the IPC surface for runtime hygiene and honest
 * readers, registered from index.ts in one delimited call.
 *
 * Kept out of index.ts so the channels a package adds do not interleave with
 * everyone else's, and so each handler's validation sits next to the module it
 * guards. Every argument arriving here came from the renderer and is untrusted.
 */
import * as processWatch from './process-watch';

type Handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void;

export function registerP5Ipc(handle: Handle): void {
  // ── what a session left running ─────────────────────────────────────
  handle('processes:forSession', (sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) {
      throw new Error('A session id is required.');
    }
    return processWatch.processesForSession(sessionId);
  });
  handle('processes:survivors', () => processWatch.allSurvivors());
  // Called by the two stop buttons just before they signal a session, so the
  // tree is recorded while the ppid chain still proves whose it is.
  handle('processes:capture', () => processWatch.captureBeforeStop().then(() => true));
  handle('processes:stop', (sessionId: unknown, pid: unknown) => processWatch.stopSurvivor(sessionId, pid));
}
