import type { QueueSlots } from '../../shared/types';
import type { WaniganModule } from '../module-registry';
import * as queue from '../queue';
import { setSetting } from '../settings';
import { migrateQueue } from './execution-storage';

/** The shared dispatcher is required because every unattended launch uses its admission boundary. */
export const queueModule: WaniganModule = {
  id: 'queue',
  label: 'Queue',
  required: {
    reason: 'Queue owns durable dispatch claims, capacity limits and admission to unattended work across Wanigan processes.',
  },
  migrate: migrateQueue,
  ipc(handle) {
    handle('queue:list', (limit?: number) => queue.listQueue(limit));
    handle('queue:counts', () => queue.queueCounts());
    handle('queue:cancel', (id: string) => queue.cancelQueued(id));
    handle('queue:slots', () => queue.slots());
    handle('queue:setSlots', (next: Partial<QueueSlots>) => {
      const v = queue.setSlots(next);
      setSetting('slots', JSON.stringify(v));
      return v;
    });

  },
};
