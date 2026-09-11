/**
 * Carrying a conversation into a fresh one — the shapes the preload names.
 *
 * In shared rather than beside the implementation: importing src/main for its
 * types alone is enough to pull the main process into the renderer's project,
 * which is how the account handoff first broke its own boundary.
 */
import type { Session } from './types';

export type HandoverBegun = { sessionId: string; prompt: string };

export type HandoverFinished =
  | { kind: 'carried'; session: Session; noteChars: number }
  | { kind: 'empty'; reason: string }
  | { kind: 'unreadable'; reason: string };
