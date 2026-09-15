import { ipcMain, type IpcMainEvent } from 'electron';
import { db } from './db';
import { spendYield } from './spend-yield';
import { projectById } from './store';
import { codexLoaderReport } from './context/codex-loader';
import { lintInstructionReferences } from './context/reference-lint';
import { agentDefinitions } from './context/agent-definitions';
import { projectionBudgetFor } from './learning-budget';
import { setSkillModelInvocation, skillListing } from './skill-listing';
import { codexCredits } from './codex-credits';
import { cacheWarmth } from './cache-warmth';
import { costCauses } from './cost-causes';
import { admissionRefusal, noteOperatorInput, previousRunsFor, scheduleCostSettings, scheduleOutcomes, setScheduleCostSettings, windowShare } from './schedule-cost';
import type { ScheduleCostDetail } from '../shared/cost-types';
import { anatomyFor } from './session-anatomy';

/**
 * IPC for the cost, quota and context surfaces, registered from index.ts's
 * registerIpc() through the same trusted-sender wrapper as every other channel.
 * Kept in its own file so the handlers and the validation of what a renderer
 * may pass sit next to each other rather than a few thousand lines apart.
 *
 * Every argument that arrives here is untrusted. Numbers are clamped, ids are
 * checked for shape, and a project is named by its id and resolved here — the
 * renderer never hands main a path to read.
 */

type Handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void;

export type CostIpcDeps = {
  liveSessionIds: () => ReadonlySet<string>;
  /** index.ts's sender check, for the one fire-and-forget listener below. */
  trusted: (event: IpcMainEvent) => boolean;
};

function days(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? Math.max(1, Math.min(365, Math.floor(n))) : undefined;
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:.-]{1,200}$/.test(value)) throw new Error(`${label} is not a valid id.`);
  return value;
}

function project(value: unknown) {
  const found = projectById(id(value, 'That project'));
  if (!found) throw new Error('That project is no longer in Wanigan’s list.');
  return found;
}

export function registerCostIpc(handle: Handle, deps: CostIpcDeps): void {
  handle('cost:yield', (window: unknown) => spendYield(days(window), deps.liveSessionIds()));
  handle('cost:codexCredits', (window: unknown) => codexCredits(days(window)));
  handle('cost:causes', (window: unknown, mcpWindow: unknown) => costCauses(days(window), days(mcpWindow), deps.liveSessionIds()));
  handle('cost:cacheWarmth', (sessionId: unknown) => cacheWarmth(id(sessionId, 'That session')));
  handle('cost:codexLoader', (projectId: unknown) => {
    const p = project(projectId);
    return codexLoaderReport(p.id, p.path);
  });
  handle('cost:referenceLint', (projectId: unknown) => {
    const p = project(projectId);
    return lintInstructionReferences(p.id, p.path);
  });
  handle('cost:agentDefinitions', (projectId: unknown) => agentDefinitions(project(projectId).path));
  handle('cost:projectionBudget', (candidateId: unknown, providerId: unknown) =>
    projectionBudgetFor(id(candidateId, 'That candidate'), id(providerId, 'That provider')));
  const optionalProject = (value: unknown) => (value === null || value === undefined || value === '' ? null : project(value).id);
  handle('cost:skillListing', (projectId: unknown) => skillListing(optionalProject(projectId)));
  // A write to a personal skill file, so it is its own explicit channel with
  // the choice spelled out; main re-reads the catalogue and refuses anything
  // that is not a personal skill Wanigan applied.
  handle('cost:windowShare', () => windowShare(deps.liveSessionIds()));
  handle('cost:anatomy', (sessionId: unknown) => anatomyFor(id(sessionId, 'That session')));
  handle('cost:scheduleDetail', (scheduleId: unknown): ScheduleCostDetail => {
    const sid = id(scheduleId, 'That schedule');
    const row = db().prepare('SELECT id, kind, payload_json, project_id FROM schedules WHERE id = ?').get(sid) as
      { id: string; kind: string; payload_json: string; project_id: string | null } | undefined;
    if (!row) throw new Error('That schedule no longer exists.');
    let payload: unknown = null;
    try { payload = JSON.parse(row.payload_json); } catch { /* an unreadable payload admits nothing and injects nothing */ }
    const settings = scheduleCostSettings(sid);
    const fires = db().prepare(`SELECT at, status, injected_context FROM schedule_runs WHERE schedule_id = ? AND injected_context IS NOT NULL
      ORDER BY at DESC LIMIT 3`).all(sid) as { at: number; status: string; injected_context: string }[];
    return {
      settings,
      outcomes: scheduleOutcomes(sid, settings.keepRuns),
      nextInjection: row.kind === 'headless' ? previousRunsFor(sid) : null,
      admissionNow: admissionRefusal({ id: sid, kind: row.kind, payload, projectId: row.project_id }, Date.now()),
      injectedFires: fires.map((f) => ({ at: f.at, status: f.status, text: f.injected_context })),
    };
  });
  handle('cost:setScheduleSettings', (scheduleId: unknown, patch: unknown) => {
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    return setScheduleCostSettings(id(scheduleId, 'That schedule'), {
      admission: p.admission as boolean | undefined, reservePct: p.reservePct as number | undefined,
      quietMinutes: p.quietMinutes as number | undefined, remember: p.remember as boolean | undefined, keepRuns: p.keepRuns as number | undefined,
    });
  });
  // A second listener on the PTY write channel, beside the one in index.ts that
  // does the writing. It keeps only the time, for the admission rule's quiet
  // period; the bytes are never looked at.
  ipcMain.on('sessions:write', (event) => { if (deps.trusted(event)) noteOperatorInput(); });
  handle('cost:setSkillModelInvocation', (projectId: unknown, harness: unknown, skillPath: unknown, allow: unknown) =>
    setSkillModelInvocation({ projectId: optionalProject(projectId), harness, path: skillPath, allow }));
}
