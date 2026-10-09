import type { DB } from './db.ts';
import type { EventName, Events } from '../shared/protocol.ts';

export type Emit = <E extends EventName>(event: E, data: Events[E]) => void;

/** What every service needs: the database, a clock, and a way to tell clients something changed. */
export interface Ctx {
  db: DB;
  now: () => number;
  emit: Emit;
}

export class Bus {
  private readonly listeners = new Set<(event: EventName, data: unknown) => void>();

  on(listener: (event: EventName, data: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  readonly emit: Emit = (event, data) => {
    for (const listener of this.listeners) listener(event, data);
  };
}
