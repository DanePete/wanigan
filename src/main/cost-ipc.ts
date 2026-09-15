import { spendYield } from './spend-yield';
import { projectById } from './store';
import { codexLoaderReport } from './context/codex-loader';
import { lintInstructionReferences } from './context/reference-lint';
import { agentDefinitions } from './context/agent-definitions';
import { projectionBudgetFor } from './learning-budget';

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
}
