import { shell } from 'electron';
import type { InteractiveSessionLoad, LaunchOptions, Session } from '../../shared/types';
import type { WaniganModule } from '../module-registry';
import {
  listSessions, createSession, recoverExactCodexThread, scrollback, interruptSession,
  killSession, closeSession, markRead, setSessionTuning, sendSessionPermissionControl,
  writeSession, resizeSession,
} from '../sessions';
import {
  assertConversationExists, pastSessions, forgetPastSession, setConversationFlag,
  renameSession, sessionBaseline,
} from '../session-history';
import * as queue from '../queue';
import { migrateSessions } from './session-storage';

/**
 * The session list as the renderer receives it.
 *
 * Identical to listSessions() except that the launch snapshot is reduced to a
 * count. `baseline.dirty` is one string per file already modified when the
 * session started — 84 in this repository, thousands in a monorepo — and three
 * independent pollers re-serialise the whole list every few seconds to render a
 * row of status text that never shows a path. The paths still exist; the code
 * panel asks for one session's worth through `sessions:baseline`.
 */
function sessionListEntries(): Session[] {
  return listSessions().map((value) => {
    const { baseline, ...rest } = value;
    if (!baseline) return rest;
    return {
      ...rest,
      baselineSummary: { head: baseline.head, dirtyCount: baseline.dirty.length, at: baseline.at },
    };
  });
}

/** Session runtime remains in ../sessions.ts; this module owns its trust boundary. */
export const sessionsModule: WaniganModule = {
  id: 'sessions',
  label: 'Sessions',
  required: {
    reason: 'Sessions owns agent launch, account selection, the PTY boundary and durable execution identity.',
  },
  migrate: migrateSessions,
  requiresStartedServices: ['create', 'recoverExactCodex'],
  ipc(handle, context) {
    handle('sessions:list', () => sessionListEntries());
    // The dispatcher meter's missing half. Every other surface is a queue row and
    // can be counted from the queue; an interactive session never creates one, so
    // the limit sessions.ts now enforces read "0 of N" on the page that sets it.
    // sessions.ts keeps its own live count module-private, so this derives the
    // same thing from the session list rather than reaching into that module.
    handle('sessions:liveCount', (): InteractiveSessionLoad => ({
      live: listSessions().filter((value) => value.status !== 'exited').length,
      limit: queue.slots().session,
    }));
    handle('sessions:create', async (opts: LaunchOptions) => {
      assertConversationExists(opts?.resumeFrom ?? null);
      const created = await createSession(opts);
      // The first live agent is what takes the power-save blocker. Doing it here
      // rather than waiting for the poller means the Mac is already held before
      // the operator has finished closing the lid.
      context.onAgentLaunched?.();
      return created;
    });
    // Separate from sessions:create: only the exact UUID + selected project
    // cross this boundary, so arbitrary launch flags cannot turn recovery into a
    // broad Codex picker or a second writer.
    handle('sessions:recoverExactCodex', (input: { threadId: unknown; projectId: unknown }) =>
      recoverExactCodexThread(input));
    handle('sessions:scrollback', (id: string) => scrollback(id));
    handle('sessions:interrupt', (id: string, force?: boolean) => interruptSession(id, force === true));
    handle('sessions:kill', (id: string) => killSession(id));
    handle('sessions:close', (id: string) => { closeSession(id); return true; });
    handle('sessions:markRead', (id: string) => { markRead(id); return true; });
    // 'sessions:write' is fire-and-forget; this typed variant exists so a tuning
    // slash command and its session-record update cannot drift apart.
    handle('sessions:setTuning', (id: string, field: unknown, value: unknown) => setSessionTuning(id, field, value));
    handle('sessions:permissionControl', (id: unknown, action: unknown) => sendSessionPermissionControl(id, action));
    // The status bar may reveal only the folder of a live Wanigan session. A
    // generic renderer-controlled shell.openPath bridge would let a compromised
    // renderer invoke arbitrary file handlers on this Mac.
    handle('sessions:reveal', async (id: string) => {
      if (typeof id !== 'string' || !id.trim() || id.length > 200) {
        throw new Error('Choose a live session to reveal its folder.');
      }
      const value = listSessions().find((candidate) => candidate.id === id);
      if (!value) throw new Error('That session is no longer open in Wanigan.');
      const target = value.worktree ?? value.projectPath;
      const error = await shell.openPath(target);
      if (error) throw new Error(`Wanigan could not open this session folder: ${error}`);
      return true;
    });
    handle('sessions:baseline', (id: string) => sessionBaseline(id));
    handle('sessions:past', (projectId?: unknown) => {
      if (projectId != null && (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 200)) {
        throw new Error('Choose a valid project to read recent conversations.');
      }
      return pastSessions(40, projectId as string | null | undefined);
    });
    handle('sessions:forget', (id: string) => { forgetPastSession(id); return pastSessions(); });
    handle('sessions:setConversationFlag', (id: string, flag: unknown, on: unknown) => {
      if (flag !== 'pin' && flag !== 'settle') throw new Error('That is not a lifecycle flag Wanigan knows.');
      return setConversationFlag(String(id), flag, on === true);
    });
    handle('sessions:rename', (id: string, title: unknown) => renameSession(String(id), title));

  },
  events(on) {
    on('sessions:write', (id: string, data: string) => { writeSession(id, data); });
    on('sessions:resize', (id: string, cols: number, rows: number) => { resizeSession(id, cols, rows); });
  },
};
