/**
 * Per-file review marks: the operator's approve, reject or comment on each file
 * a session changed, and the "needs review" state that follows from them.
 *
 * A mark is about one version of one file. It records the content hash the file
 * had when it was marked, and a file whose bytes have moved since is not
 * approved any more — it shows "changed since you marked it" — because an
 * approval that silently carries over to code nobody read is the one outcome a
 * review mark exists to prevent. The mark itself is kept, note and all, so the
 * operator can see what they said about the previous version.
 *
 * Nothing here reads git or the database. The main process supplies the files
 * of a diff and the marks it has stored; every decision about what those mean
 * is made here, where a test can hold it.
 */
import { formatNoteEntry, type ReviewNote } from './review-notes.ts';

export const REVIEW_MARK_STATES = ['unreviewed', 'commented', 'approved', 'rejected'] as const;
export type ReviewMarkState = (typeof REVIEW_MARK_STATES)[number];

/** The hash recorded for a file that does not exist on the reviewed side. */
export const DELETED_HASH = 'deleted';

export const MAX_MARK_NOTE_CHARS = 2_000;

/** One stored mark. The diff identity is session + worktree + base commit + path. */
export type ReviewMark = {
  path: string;
  state: ReviewMarkState;
  note: string | null;
  /** The file's content hash when it was marked, or DELETED_HASH. */
  contentHash: string;
  worktree: string;
  baseCommit: string;
  markedAt: number;
};

/** One changed file of a session's diff against its base, as main reads it. */
export type ReviewFile = {
  path: string;
  /** The path before a rename, so a filter and a mark can find it by either name. */
  oldPath: string | null;
  /** git's name-status letter: A, M, D, R, C, T, or '?' for untracked. */
  status: string;
  /** Null for a binary file, where git counts no lines. */
  added: number | null;
  removed: number | null;
  binary: boolean;
  /** The working-tree blob hash now, or DELETED_HASH. */
  contentHash: string;
  /**
   * Already dirty when the session launched, so the operator's work rather
   * than the session's. Undefined when no launch baseline was recorded.
   */
  preexisting?: boolean;
  /* ── helper sweep · P7 depth ── */
  /** Why this file is scratch and left out of the review, or null/undefined when it counts. See shared/scratch-files.ts. */
  scratch?: import('./scratch-files.ts').ScratchReason | null;
};

/** What a file's review looks like right now. */
export type FileReview = {
  state: ReviewMarkState;
  /** A mark exists but the file's bytes have changed since it was made. */
  stale: boolean;
  /** The state as it was marked, before staleness is applied; null with no mark. */
  marked: ReviewMarkState | null;
  note: string | null;
  markedAt: number | null;
};

export function validMarkState(value: unknown): value is ReviewMarkState {
  return typeof value === 'string' && (REVIEW_MARK_STATES as readonly string[]).includes(value);
}

/**
 * The review of one file. A stale mark reads as unreviewed for every decision,
 * and keeps its note for the reader.
 */
export function fileReview(file: Pick<ReviewFile, 'path' | 'contentHash'>, marks: readonly ReviewMark[]): FileReview {
  const mark = marks.find((m) => m.path === file.path);
  if (!mark || mark.state === 'unreviewed') return { state: 'unreviewed', stale: false, marked: null, note: mark?.note ?? null, markedAt: mark?.markedAt ?? null };
  const stale = mark.contentHash !== file.contentHash;
  return { state: stale ? 'unreviewed' : mark.state, stale, marked: mark.state, note: mark.note, markedAt: mark.markedAt };
}

/** The files a review is about: the session's own, never the operator's pre-existing edits, and never its scratch files. */
export function reviewableFiles<T extends Pick<ReviewFile, 'preexisting' | 'scratch'>>(files: readonly T[]): T[] {
  return files.filter((f) => f.preexisting !== true && !f.scratch);
}

export type ReviewCounts = {
  files: number;
  approved: number;
  rejected: number;
  commented: number;
  /** Marks whose file has changed since; included in `unreviewed`. */
  stale: number;
  unreviewed: number;
  /** Lines, summed over files git could count; binary files add nothing. */
  added: number;
  removed: number;
  binary: number;
};

export function reviewCounts(files: readonly ReviewFile[], marks: readonly ReviewMark[]): ReviewCounts {
  const counts: ReviewCounts = { files: 0, approved: 0, rejected: 0, commented: 0, stale: 0, unreviewed: 0, added: 0, removed: 0, binary: 0 };
  for (const file of reviewableFiles(files)) {
    counts.files += 1;
    const review = fileReview(file, marks);
    if (review.stale) counts.stale += 1;
    counts[review.state] += 1;
    if (file.binary) counts.binary += 1;
    counts.added += file.added ?? 0;
    counts.removed += file.removed ?? 0;
  }
  return counts;
}

/** Why a session does or does not need review — a reason code, never a score. */
export type NeedsReviewReason =
  /** Still working: a turn is in flight, so the diff is not the one to review yet. */
  | 'working'
  /** The launch recorded no base commit, so there is no diff to review against. */
  | 'no-base'
  /** git could not produce the diff; nothing is claimed either way. */
  | 'unreadable'
  /** The session changed nothing against its base. */
  | 'no-diff'
  /** Every changed file carries an approval of its current bytes. */
  | 'all-approved'
  /** At least one changed file is unreviewed, rejected, commented or stale. */
  | 'unapproved-files';

export type NeedsReviewVerdict = {
  needsReview: boolean;
  reason: NeedsReviewReason;
  /** One sentence, stated with the rule, for the chip's accessible description. */
  because: string;
  counts: ReviewCounts;
};

export type TurnState = 'exited' | 'turn-ended' | 'working';

/**
 * A session needs review when its turn is over (it exited or finished a turn),
 * its diff against base is non-empty, and not every changed file is approved.
 */
export function needsReviewVerdict(input: {
  turn: TurnState;
  base: string | null;
  unreadable: string | null;
  files: readonly ReviewFile[];
  marks: readonly ReviewMark[];
}): NeedsReviewVerdict {
  const counts = reviewCounts(input.files, input.marks);
  const verdict = (needsReview: boolean, reason: NeedsReviewReason, because: string): NeedsReviewVerdict =>
    ({ needsReview, reason, because, counts });
  if (!input.base) return verdict(false, 'no-base', 'No base commit was recorded when this session launched, so there is no diff to review against.');
  if (input.unreadable) return verdict(false, 'unreadable', `git could not read this session's diff: ${input.unreadable}`);
  if (counts.files === 0) return verdict(false, 'no-diff', 'The session changed nothing against the commit it started from.');
  if (input.turn === 'working') return verdict(false, 'working', 'The session is still in a turn; its diff is reviewed once the turn ends.');
  const open = counts.files - counts.approved;
  if (open === 0) return verdict(false, 'all-approved', `All ${counts.files} changed file${counts.files === 1 ? ' is' : 's are'} approved as they stand.`);
  const ended = input.turn === 'exited' ? 'It exited' : 'Its turn ended';
  return verdict(true, 'unapproved-files',
    `${ended} with ${counts.files} changed file${counts.files === 1 ? '' : 's'}, and ${open} ${open === 1 ? 'is' : 'are'} not approved.`);
}

/** "Needs review · 3 of 7 files", the chip's words. */
export function needsReviewLabel(verdict: Pick<NeedsReviewVerdict, 'counts'>): string {
  const { approved, files } = verdict.counts;
  return `Needs review · ${approved} of ${files} file${files === 1 ? '' : 's'}`;
}

/** "+120 −30", or null when git counted nothing (binary-only, or no files). */
export function diffStatLabel(added: number, removed: number): string {
  return `+${added.toLocaleString('en-US')} −${removed.toLocaleString('en-US')}`;
}

/**
 * A file review mark a person would read as settled. Staleness is decided on
 * the hash alone; a mark on a file whose path no longer changes is simply not
 * listed, because the file is no longer part of the diff.
 */
export function highTierUnapproved(
  files: readonly ReviewFile[],
  marks: readonly ReviewMark[],
  tierOf: (path: string) => 'high' | 'medium' | null,
): ReviewFile[] {
  return reviewableFiles(files).filter((f) => {
    if (tierOf(f.path) !== 'high' && !(f.oldPath && tierOf(f.oldPath) === 'high')) return false;
    return fileReview(f, marks).state !== 'approved';
  });
}

/** A dependency line the review message lists, already worded by the dependency parser. */
export type ReviewDependencyLine = { text: string };

/**
 * The one message "Send review" puts into the session's message box. It follows
 * the review-notes register: a header naming the diff, the instruction, then
 * numbered items with the file in backticks, each quoting what the operator
 * said. Approved files are counted, not listed, because they ask nothing.
 *
 * Nothing is sent. The operator reads this in the message box and presses Send.
 */
export function formatReviewSubmission(input: {
  anchor: string;
  files: readonly ReviewFile[];
  marks: readonly ReviewMark[];
  lineNotes?: readonly ReviewNote[];
  dependencies?: readonly ReviewDependencyLine[];
}): { ok: true; text: string; items: number } | { ok: false; reason: string } {
  const files = reviewableFiles(input.files);
  const rejected: { file: ReviewFile; review: FileReview }[] = [];
  const commented: { file: ReviewFile; review: FileReview }[] = [];
  const staleNoted: { file: ReviewFile; review: FileReview; was: ReviewMarkState }[] = [];
  let approved = 0;
  for (const file of files) {
    const review = fileReview(file, input.marks);
    const mark = input.marks.find((m) => m.path === file.path);
    if (review.stale && mark && (mark.state === 'rejected' || mark.state === 'commented')) {
      staleNoted.push({ file, review, was: mark.state });
      continue;
    }
    if (review.state === 'rejected') rejected.push({ file, review });
    else if (review.state === 'commented') commented.push({ file, review });
    else if (review.state === 'approved') approved += 1;
  }
  const notes = input.lineNotes ?? [];
  const deps = input.dependencies ?? [];
  const items = rejected.length + commented.length + staleNoted.length + notes.length;
  if (items === 0) {
    return { ok: false, reason: 'There is nothing to send: no file is rejected or commented on, and no line note is waiting.' };
  }

  const lines: string[] = [
    `Review of ${input.anchor}.`,
    'Address each one, or reply saying why you are leaving it as it is.',
  ];
  let n = 0;
  const body = (text: string | null, fallback: string) => {
    for (const para of (text?.trim() || fallback).split('\n')) lines.push(`   ${para}`);
  };
  for (const { file, review } of rejected) {
    n += 1;
    lines.push('', `${n}. \`${file.path}\` — rejected:`);
    body(review.note, 'Rejected without a note. Say what you would change, or revert it.');
  }
  for (const { file, review } of commented) {
    n += 1;
    lines.push('', `${n}. \`${file.path}\` — comment:`);
    body(review.note, '(no text)');
  }
  for (const { file, review, was } of staleNoted) {
    n += 1;
    lines.push('', `${n}. \`${file.path}\` — ${was === 'rejected' ? 'rejected' : 'comment'}, made on an earlier version of this file:`);
    body(review.note, was === 'rejected' ? 'Rejected without a note.' : '(no text)');
  }
  notes.forEach((note) => {
    n += 1;
    lines.push('', ...formatNoteEntry(note, n));
  });
  if (deps.length) {
    lines.push('', 'Dependencies this diff adds, changes or removes — say why each one is needed:');
    for (const dep of deps) lines.push(`- ${dep.text}`);
  }
  if (approved > 0) {
    lines.push('', `${approved} other file${approved === 1 ? ' is' : 's are'} approved as ${approved === 1 ? 'it stands' : 'they stand'}.`);
  }
  return { ok: true, text: lines.join('\n'), items };
}

/**
 * The marks behind a list of reviewed files, rebuilt for the message builder.
 * A stale mark keeps its state and gets a hash that cannot match, so it stays
 * stale on the way through.
 */
export function marksFromReviews(files: readonly (ReviewFile & { review: FileReview })[], worktree: string, baseCommit: string): ReviewMark[] {
  return files.filter((f) => f.review.marked !== null).map((f) => ({
    path: f.path,
    state: f.review.marked as ReviewMarkState,
    note: f.review.note,
    contentHash: f.review.stale ? `${f.contentHash}:stale` : f.contentHash,
    worktree,
    baseCommit,
    markedAt: f.review.markedAt ?? 0,
  }));
}

/** The anchor sentence for a session's whole diff against its base commit. */
export function branchAnchor(baseCommit: string): string {
  return `this session's changes against ${baseCommit.slice(0, 8)}, the commit it started from`;
}
