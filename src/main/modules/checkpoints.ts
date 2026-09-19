import type { WaniganModule } from '../module-registry';
import * as checkpoints from '../checkpoints';
import { migrateCheckpoints } from './session-storage';

export const checkpointsModule: WaniganModule = {
  id: 'checkpoints',
  label: 'Checkpoints',
  required: {
    reason: 'Checkpoints owns per-turn checkout evidence and the validated boundary for restoring agent changes.',
  },
  migrate: migrateCheckpoints,
  ipc(handle) {
    handle('checkpoints:list', (sessionId: string) => checkpoints.listCheckpoints(String(sessionId)));
    handle('checkpoints:diff', (sessionId: string, fromId: number, toId: number) => {
      if (!Number.isInteger(fromId) || !Number.isInteger(toId)) throw new Error('Those checkpoint ids are not valid.');
      return checkpoints.checkpointDiff(String(sessionId), fromId, toId);
    });
    handle('checkpoints:revertPlan', (sessionId: string, checkpointId: number) => {
      if (!Number.isInteger(checkpointId)) throw new Error('That checkpoint id is not valid.');
      return checkpoints.checkpointRevertPlan(String(sessionId), checkpointId);
    });
    handle('checkpoints:revert', (sessionId: string, checkpointId: number) => {
      if (!Number.isInteger(checkpointId)) throw new Error('That checkpoint id is not valid.');
      return checkpoints.applyCheckpointRevert(String(sessionId), checkpointId);
    });
    handle('checkpoints:removeRepo', (projectPath: string, apply: boolean) =>
      checkpoints.removeRepoCheckpoints(String(projectPath), apply === true));

  },
};
