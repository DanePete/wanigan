// Which phone the current request comes from, so Activity says "You, from
// Dane's iPhone" for what the owner did there, without every board method
// being told. Set for the length of one phone request, across its awaits.
import { AsyncLocalStorage } from 'node:async_hooks';

const current = new AsyncLocalStorage<string>();

/** Run `fn` as done from a phone, named by its Activity actor. */
export function asPhone<T>(actor: string, fn: () => T): T {
  return current.run(actor, fn);
}

/** The phone the current request comes from, as an Activity actor, or null. */
export function phoneActorNow(): string | null {
  return current.getStore() ?? null;
}
