/**
 * Which turn added a dependency, read from the session's per-turn checkpoints.
 *
 * The review lists what a session's diff did to a manifest against the commit
 * it started from. That answers "what changed" and not "when", and "when" is
 * what lets an operator open the turn and read the prompt, the reasoning and
 * the install command that went with it. The checkpoints already hold every
 * boundary as a real git snapshot, so the answer is a sequence of readings of
 * the manifest — the base commit, each snapshot in order, the working tree now
 * — and the first span between two readings that made the change.
 *
 * Only a span that runs from a turn's start snapshot to its end is a turn.
 * Everything else is said as what it is: before the first checkpoint (the
 * working tree already held it at launch), between snapshots but outside any
 * turn (an edit between prompts, a turn with no end snapshot, the working tree
 * since the last one), or unknown, with the reason. A reading that could not be
 * parsed stops the search: a later span cannot be called the first one to make
 * the change when an earlier span could not be read.
 */

import { diffDependencies, isInstallCommand, type DepChange, type DepEntry } from './dependencies.ts';

/** One reading of a manifest, in the order the session produced them. */
export type ManifestPoint = {
  source: 'base' | 'checkpoint' | 'working-tree';
  checkpointId: number | null;
  turn: number | null;
  /** The checkpoint kind: session-start, turn-start, turn-end, session-end, pre-revert. */
  kind: string | null;
  at: number | null;
  /** Null when this reading could not be taken or parsed; `unreadable` says why. */
  entries: DepEntry[] | null;
  unreadable: string | null;
};

export type InstallInTurn =
  | { state: 'ran'; commands: { command: string; ok: boolean | null; exitCode: number | null }[] }
  | { state: 'none-recorded' }
  | { state: 'no-hook-record' };

export type DepTurnAttribution =
  | {
      state: 'turn';
      turn: number;
      /** The two checkpoints the turn's diff runs between. */
      fromCheckpoint: number;
      toCheckpoint: number;
      install: InstallInTurn;
      /** Other turns whose snapshots also changed this entry. */
      alsoTurns: number[];
      detail: string;
    }
  | { state: 'before-first-checkpoint' | 'outside-turns' | 'no-checkpoints' | 'unknown'; detail: string; alsoTurns: number[] };

type SpanKind = 'before-first' | 'turn' | 'outside';
type Span = { from: ManifestPoint; to: ManifestPoint; kind: SpanKind; turn: number | null; where: string };

const END_KINDS = new Set(['turn-end', 'session-end', 'pre-revert']);

/** Consecutive readings, each pair named for what a person would call that stretch of the session. */
export function spansOf(points: readonly ManifestPoint[]): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const p = points[i], q = points[i + 1];
    if (p.source === 'base') {
      spans.push({ from: p, to: q, kind: 'before-first', turn: null, where: 'before the first checkpoint' });
      continue;
    }
    if (p.source === 'checkpoint' && q.source === 'checkpoint' && p.kind === 'turn-start' && q.turn === p.turn && END_KINDS.has(q.kind ?? '')) {
      spans.push({ from: p, to: q, kind: 'turn', turn: p.turn, where: `turn ${p.turn}` });
      continue;
    }
    spans.push({ from: p, to: q, kind: 'outside', turn: null, where: outsideWhere(p, q) });
  }
  return spans;
}

function outsideWhere(p: ManifestPoint, q: ManifestPoint): string {
  if (p.kind === 'turn-start' && q.source === 'working-tree') {
    return `after turn ${p.turn} began — it has no end snapshot yet, so a change since then is not placed in it`;
  }
  if (p.kind === 'turn-start') return `after turn ${p.turn} began — that turn has no end snapshot, so a change in it is not placed in it`;
  if (p.kind === 'pre-revert') return `across a restore to an earlier checkpoint${p.turn ? ` during turn ${p.turn}` : ''}`;
  if (q.source === 'working-tree') return p.turn ? `in the working tree since the last snapshot, after turn ${p.turn}` : 'in the working tree since the launch snapshot';
  if (p.kind === 'session-start') return q.turn ? `after the launch snapshot and before turn ${q.turn} began` : 'after the launch snapshot';
  if (q.kind === 'turn-start' && p.turn) return `between turn ${p.turn} and turn ${q.turn}`;
  return 'between two snapshots, outside any turn';
}

const keyOf = (c: { section: string; name: string }) => `${c.section}\x00${c.name}`;

/** Whether a span's own change to an entry is the kind of change the whole diff made. */
function compatible(whole: DepChange['change'], step: DepChange['change']): boolean {
  if (whole === 'added') return step === 'added';
  if (whole === 'removed') return step === 'removed';
  // A version move, or the entry taken out and put back at another version.
  return step !== 'removed';
}

function installsBetween(from: number | null, to: number | null, commands: readonly InstallCommand[], hooksRecorded: boolean): InstallInTurn {
  if (!hooksRecorded) return { state: 'no-hook-record' };
  if (from === null || to === null) return { state: 'none-recorded' };
  const ran = commands.filter((c) => c.at >= from && c.at <= to && isInstallCommand(c.command));
  return ran.length ? { state: 'ran', commands: ran.map(({ command, ok, exitCode }) => ({ command, ok, exitCode })) } : { state: 'none-recorded' };
}

export type InstallCommand = { at: number; command: string; ok: boolean | null; exitCode: number | null };

/**
 * One attribution per change, in the order given. `points` runs base first,
 * working tree last, checkpoints in capture order between; with no checkpoint
 * among them there is nothing to attribute to, and each change says so.
 */
export function attributeDependencyChanges(input: {
  changes: readonly DepChange[];
  points: readonly ManifestPoint[];
  commands: readonly InstallCommand[];
  hooksRecorded: boolean;
}): DepTurnAttribution[] {
  const { changes, points, commands, hooksRecorded } = input;
  if (!points.some((p) => p.source === 'checkpoint')) {
    return changes.map(() => ({ state: 'no-checkpoints', alsoTurns: [], detail: 'No per-turn checkpoint was captured for this session, so no turn can be named.' }));
  }
  const spans = spansOf(points);
  return changes.map((change) => {
    const key = keyOf(change);
    let found: Span | null = null;
    let blocked: Span | null = null;
    const touching: number[] = [];
    for (const span of spans) {
      if (span.from.entries === null || span.to.entries === null) {
        if (!found && !blocked) blocked = span;
        continue;
      }
      const step = diffDependencies(span.from.entries, span.to.entries).find((c) => keyOf(c) === key);
      if (!step) continue;
      if (span.kind === 'turn' && span.turn !== null) touching.push(span.turn);
      if (!found && !blocked && compatible(change.change, step.change)) found = span;
    }
    if (blocked) {
      const side = blocked.from.entries === null ? blocked.from : blocked.to;
      return {
        state: 'unknown', alsoTurns: touching,
        detail: `The manifest could not be read ${side.source === 'base' ? 'at the base commit' : side.source === 'working-tree' ? 'in the working tree' : `at the ${side.kind ?? ''} snapshot${side.turn ? ` of turn ${side.turn}` : ''}`}${side.unreadable ? ` (${side.unreadable})` : ''}, so the first turn that made this change cannot be said.`,
      };
    }
    if (!found) {
      return { state: 'unknown', alsoTurns: touching, detail: touching.length
        ? `Turn${touching.length === 1 ? '' : 's'} ${touching.join(', ')} changed this entry, but in steps that do not add up to this change on their own.`
        : 'No span between the recorded snapshots shows this change.' };
    }
    const first: Span = found;
    const also = touching.filter((n) => n !== first.turn);
    if (first.kind === 'turn' && first.turn !== null && first.from.checkpointId !== null && first.to.checkpointId !== null) {
      return {
        state: 'turn', turn: first.turn, fromCheckpoint: first.from.checkpointId, toCheckpoint: first.to.checkpointId,
        install: installsBetween(first.from.at, first.to.at, commands, hooksRecorded), alsoTurns: also,
        detail: `Turn ${first.turn}'s snapshots are the first to show this change.`,
      };
    }
    if (first.kind === 'before-first') {
      return { state: 'before-first-checkpoint', alsoTurns: also, detail: 'The working tree already had this change when the launch snapshot was taken, before the first turn.' };
    }
    return { state: 'outside-turns', alsoTurns: also, detail: `This change first appears ${first.where}.` };
  });
}

/** A short phrase for a row: "turn 2", "before the first checkpoint", "outside the recorded turns". */
export function attributionPhrase(a: DepTurnAttribution): string {
  switch (a.state) {
    case 'turn': return `turn ${a.turn}`;
    case 'before-first-checkpoint': return 'before the first checkpoint';
    case 'outside-turns': return 'outside the recorded turns';
    case 'no-checkpoints': return 'no checkpoints recorded';
    case 'unknown': return 'turn unknown';
  }
}

/** What the attributed turn's install record says, as a sentence fragment. */
export function installPhrase(install: InstallInTurn): string {
  switch (install.state) {
    case 'ran': {
      const first = install.commands[0];
      const failed = first.ok === false ? ` (failed${first.exitCode !== null ? `, exit ${first.exitCode}` : ''})` : '';
      const more = install.commands.length > 1 ? ` and ${install.commands.length - 1} more` : '';
      return `an install command ran in that turn: \`${first.command}\`${failed}${more}`;
    }
    case 'none-recorded': return 'no install command is recorded in that turn';
    case 'no-hook-record': return 'this session has no hook record, so whether an install ran in that turn is unknown';
  }
}
