// A git action asked for from outside the workbench (⌘K, the app menu, a
// chord): kept here until the workbench is on screen to take it, so a command
// that first has to navigate there still happens once, and only once.
import { useEffect, useRef } from 'react';
import type { GitTab } from '@shared/views';

export type GitIntent = 'commit' | 'push' | 'pull' | 'fetch' | 'switch' | 'branch' | 'stash';

/** The tab each action happens on. */
export const INTENT_TAB: Record<GitIntent, GitTab> = {
  commit: 'changes', push: 'changes', pull: 'changes', fetch: 'changes', switch: 'branches', branch: 'branches', stash: 'stashes',
};

let pending: { intent: GitIntent; at: number } | null = null;
const listeners = new Set<() => void>();

/** Ask the workbench to do something; it does when it is next on screen (within a few seconds). */
export function requestGit(intent: GitIntent): void {
  pending = { intent, at: Date.now() };
  for (const l of listeners) l();
}

/** Take an asked-for action this part of the view does (`accepts`), when one is waiting and the view is ready for it. */
export function useGitIntent(ready: boolean, accepts: readonly GitIntent[], handle: (intent: GitIntent) => void): void {
  const run = useRef(handle);
  run.current = handle;
  const kinds = accepts.join();
  useEffect(() => {
    if (!ready) return undefined;
    const take = (): void => {
      if (!pending || !kinds.split(',').includes(pending.intent)) return;
      const { intent, at } = pending;
      pending = null;
      // An ask older than this was for a view the owner has since left.
      if (Date.now() - at < 5_000) run.current(intent);
    };
    take();
    listeners.add(take);
    return () => { listeners.delete(take); };
  }, [ready, kinds]);
}
