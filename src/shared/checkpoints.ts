// A checkpoint per turn: what git recorded of a session's folder when the
// session started and when each turn ended, and when the last turn may be
// undone. Pure, so the rules are tested without git.
import { LIVE_STATES, type ChangedFile, type Provider, type SessionState } from './model.ts';

/** What a checkpoint records: the session starting, a turn ending, or the owner undoing or redoing the last turn. */
export type CheckpointKind = 'start' | 'turn' | 'undo' | 'redo';

export interface Checkpoint {
  id: number;
  sessionId: string;
  kind: CheckpointKind;
  /** The turn, counted by prompts as the timeline counts them (0 before the first prompt). Undo and redo carry the turn they act on. */
  turn: number;
  /** The hook event that ended the turn, so the timeline can find its turn. */
  eventId: number | null;
  at: number;
  /** Why it was not taken ("Not a git repository"); null when it was. */
  notCaptured: string | null;
  /** What changed since the checkpoint before it; null when that is unknown. */
  files: number | null;
  additions: number | null;
  deletions: number | null;
  /** Another session was live in the same folder during the turn, so its edits may be in here. */
  shared: boolean;
}

/** What the owner may do to the last turn: undo it, or redo an undo. */
export interface LastTurn {
  action: 'undo' | 'redo';
  turn: number;
  /** The checkpoint the action starts from; undoing names it, so a stale button is refused. */
  checkpointId: number;
  /** The turn's own checkpoint, whose changes the confirmation lists. */
  turnCheckpointId: number | null;
  eventId: number | null;
  files: number | null;
  /** Why not, shown in place of the button; null when it can be done. */
  refusal: string | null;
}

export interface SessionCheckpoints {
  checkpoints: Checkpoint[];
  last: LastTurn | null;
}

export interface TurnFile extends ChangedFile {
  /** The unified diff, or null when there was too much to send (or it is binary). */
  diff: string | null;
  truncated: boolean;
}

/** What one turn changed: its checkpoint against the one before it. */
export interface TurnChanges {
  checkpointId: number;
  turn: number;
  /** Why the changes cannot be shown (not captured, or git no longer has the objects); null when they can. */
  gone: string | null;
  files: TurnFile[];
  additions: number;
  deletions: number;
  shared: boolean;
  /** An earlier turn whose changes are in here too, because it was not captured. */
  includes: string | null;
}

/** "turn 4". A turn that ended before any prompt was recorded (Codex's first) is the first turn. */
export const turnName = (n: number): string => (n > 0 ? `turn ${n}` : 'the first turn');

export const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export interface UndoFacts {
  action: 'undo' | 'redo';
  turn: number;
  /** Why the last checkpoint was not taken, when it was not. */
  notCaptured: string | null;
  /** The checkpoint before the turn was not taken, so undoing it would undo more than one turn. */
  gapBefore: boolean;
  /** HEAD moved during the turn: the agent made a commit. */
  committed: boolean;
  files: number | null;
  state: SessionState;
  provider: Provider;
  /** The session works in a card's own worktree, not the project folder. */
  worktree: boolean;
  /** The folder it works in still exists. */
  folder: boolean;
  /** Other live sessions in the same folder, by title. */
  others: string[];
}

const AGENT: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', shell: 'The shell' };

/**
 * Why the last turn cannot be undone (or its undo redone) now, or null when
 * it can — before the folder itself is checked, which needs git. The lasting
 * reasons come first.
 */
export function whyNotUndo(f: UndoFacts): string | null {
  const name = turnName(f.turn);
  const verb = f.action === 'undo' ? 'Undo' : 'Redo';
  if (!f.worktree) return `${verb} is offered only in a card’s own worktree. This session works in the project folder, where your own changes live too.`;
  if (!f.folder) return 'The folder this session worked in is gone.';
  if (LIVE_STATES.has(f.state) && f.state !== 'waiting') {
    const doing = f.state === 'permission' ? 'is asking for permission' : f.state === 'limited' ? 'stopped at its usage limit' : 'is working';
    return `${AGENT[f.provider]} ${doing}. ${verb} waits until it is idle at its prompt.`;
  }
  if (f.others.length === 1) return `${f.others[0]} is also running in this folder.`;
  if (f.others.length > 1) return `${f.others.length} other sessions are running in this folder.`;
  if (f.notCaptured) return `${capitalise(name)} was not captured (${f.notCaptured}), so there is nothing to go back to.`;
  if (f.gapBefore) return `The turn before ${name} was not captured, so undoing it would undo more than one turn.`;
  if (f.files === 0) return `${capitalise(name)} changed no files.`;
  if (f.committed) return `${AGENT[f.provider]} made a commit during ${name}. Undo changes files only, so it would leave that commit behind.`;
  return null;
}

/** "You undid turn 4: 3 files". */
export function undoSummary(action: 'undo' | 'redo', turn: number, files: number): string {
  return `You ${action === 'undo' ? 'undid' : 'redid'} ${turnName(turn)}: ${files} file${files === 1 ? '' : 's'}`;
}
