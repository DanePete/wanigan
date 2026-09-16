/**
 * Assisted-by trailers: the agents Wanigan saw working in a repository, as the
 * lines a commit it makes can end with. src/main/assisted-by.ts reads
 * session_log and git; this decides what those rows amount to.
 *
 * The line follows the convention the Linux kernel adopted for AI-assisted
 * patches — `Assisted-by: AGENT (MODEL)` — rather than Co-authored-by, which
 * GitHub renders as a person and which claims authorship nobody observed.
 *
 * What it can say is bounded by what Wanigan saw, and the preview says so:
 *   - only sessions Wanigan started are rows here. An agent run in another
 *     terminal never reached session_log, so its absence is not a statement
 *     that no agent helped;
 *   - the model is the one session_log last recorded for the session. A switch
 *     Wanigan observed updates it; a model the session used and then left is not
 *     remembered separately;
 *   - "worked in this repository" means the session's own directory — its
 *     worktree when it had one, its project otherwise — is this checkout or sits
 *     inside it. A session in another worktree of the same repository wrote to a
 *     different checkout, and its work arrives here only through a merge.
 */
import { harnessLabel } from './types.ts';

export type AssistedSessionRow = {
  harnessId: string | null;
  providerId: string;
  model: string | null;
  startedAt: number;
  endedAt: number | null;
  /** 'wanigan' for sessions Wanigan started; anything else was observed, not recorded. */
  origin: string;
  /** Whether the session's own directory is this checkout or inside it. Main resolves the paths. */
  inRepository: boolean;
};

/** Sessions that overlapped [since, until] count. `since` null means the branch has no commit to start from. */
export type AssistedWindow = { since: number | null; until: number };

export type AssistedByPreview = {
  enabled: boolean;
  /** The exact lines the commit will carry, sorted so a preview and a commit compare equal. */
  trailers: string[];
  /** Recorded sessions behind those lines, before same-agent, same-model rows were merged. */
  sessions: number;
  since: number | null;
  until: number;
};

/** Printed where a session's model was never recorded, rather than guessing one. */
export const MODEL_NOT_RECORDED = 'model not recorded';

/** Nothing from a database row may add a line, a parenthesis or a second trailer to a commit message. */
function only(text: string, allowed: RegExp, max: number): string {
  return [...text].filter((ch) => allowed.test(ch)).join('').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function assistedByLine(harness: string, model: string | null): string {
  const who = only(harness, /[A-Za-z0-9 ._+-]/, 60) || 'unknown agent';
  const what = model ? only(model, /[A-Za-z0-9._:/@+[\]-]/, 80) : '';
  return `Assisted-by: ${who} (${what || MODEL_NOT_RECORDED})`;
}

export function ranInWindow(row: Pick<AssistedSessionRow, 'startedAt' | 'endedAt'>, window: AssistedWindow): boolean {
  if (row.startedAt > window.until) return false;
  if (window.since === null) return true;
  // No recorded end is a session still running, or one that never got to say it
  // stopped; either way it may have written what is being committed.
  return row.endedAt === null || row.endedAt >= window.since;
}

export function assistedByTrailers(rows: readonly AssistedSessionRow[], window: AssistedWindow): { trailers: string[]; sessions: number } {
  const lines = new Set<string>();
  let sessions = 0;
  for (const row of rows) {
    if (row.origin !== 'wanigan' || !row.inRepository || !ranInWindow(row, window)) continue;
    sessions += 1;
    lines.add(assistedByLine(harnessLabel(row.harnessId ?? row.providerId), row.model));
  }
  return { trailers: [...lines].sort(), sessions };
}

export function sameTrailers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}
