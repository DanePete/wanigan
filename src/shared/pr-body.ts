/**
 * A pull request body written from what Wanigan recorded, with no model call.
 *
 * Tools that draft a PR description ask a model to summarise the branch. This
 * one lists evidence instead: the goal and its acceptance checks as written, how
 * many turns the session took, the files with their line counts, the review
 * gate commands with the exit codes they actually returned, the review marks
 * that were resolved, and the dependencies the diff changed. Every line is a
 * fact a reader can check, and the body says where it came from.
 *
 * The operator edits it before anything is created. Nothing here decides
 * whether the work is good; an acceptance check is listed, never ticked.
 */

export type PrEvidence = {
  goal: { title: string; acceptance: readonly string[] } | null;
  turns: number | null;
  files: readonly { path: string; added: number | null; removed: number | null }[];
  checks: readonly { command: string; exitCode: number | null; durationMs: number | null; where: string }[];
  review: { approved: number; rejected: number; commented: number; resolved: number; files: number } | null;
  dependencies: readonly string[];
  /* ── helper sweep · P7 depth ── */
  /** Changed files set aside as scratch and not listed; see shared/scratch-files.ts. */
  scratchFiles?: number;
};

export const PR_BODY_FOOTER = "Written from Wanigan's recorded evidence.";
const MAX_FILES_LISTED = 30;
const MAX_CHECKS_LISTED = 12;

function seconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  return ms < 1000 ? ` in ${Math.round(ms)}ms` : ` in ${(ms / 1000).toFixed(1)}s`;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

export function buildPrBody(evidence: PrEvidence): string {
  const out: string[] = [];

  if (evidence.goal) {
    out.push(`## Goal: ${evidence.goal.title}`);
    if (evidence.goal.acceptance.length) {
      out.push('', 'Acceptance checks, as written on the goal (not graded here):');
      for (const check of evidence.goal.acceptance) out.push(`- ${check}`);
    }
    out.push('');
  }

  out.push('## What changed');
  const counted = evidence.files.filter((f) => f.added !== null && f.removed !== null);
  const added = counted.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = counted.reduce((n, f) => n + (f.removed ?? 0), 0);
  const binary = evidence.files.length - counted.length;
  if (evidence.turns !== null) out.push(`- ${plural(evidence.turns, 'turn')} recorded in the session`);
  out.push(`- ${plural(evidence.files.length, 'file')} changed (+${added.toLocaleString('en-US')} −${removed.toLocaleString('en-US')}${binary ? `, ${plural(binary, 'binary file')} not counted` : ''})`);
  for (const f of evidence.files.slice(0, MAX_FILES_LISTED)) {
    out.push(`  - \`${f.path}\` ${f.added === null ? 'binary' : `+${f.added} −${f.removed}`}`);
  }
  if (evidence.files.length > MAX_FILES_LISTED) out.push(`  - and ${plural(evidence.files.length - MAX_FILES_LISTED, 'more file')}`);
  /* ── helper sweep · P7 depth ── */
  if (evidence.scratchFiles) out.push(`  - ${plural(evidence.scratchFiles, 'scratch file')} (temporary, ignored, or under scratch/ or tmp/) not listed or counted`);

  out.push('', '## Checks run');
  if (!evidence.checks.length) {
    out.push('- No review-gate command is recorded for this work.');
  } else {
    for (const c of evidence.checks.slice(0, MAX_CHECKS_LISTED)) {
      const result = c.exitCode === null ? 'did not exit on its own' : `exit ${c.exitCode}`;
      out.push(`- \`${c.command}\` → ${result}${seconds(c.durationMs)} (${c.where})`);
    }
    if (evidence.checks.length > MAX_CHECKS_LISTED) out.push(`- and ${plural(evidence.checks.length - MAX_CHECKS_LISTED, 'more command')}`);
  }

  if (evidence.review) {
    const r = evidence.review;
    out.push('', '## Review in Wanigan');
    out.push(`- ${r.approved} of ${plural(r.files, 'file')} approved, ${r.rejected} rejected, ${r.commented} with a comment`);
    out.push(`- ${plural(r.resolved, 'review note')} resolved (a rejection or comment on a file later approved)`);
  }

  if (evidence.dependencies.length) {
    out.push('', '## Dependencies');
    for (const d of evidence.dependencies) out.push(`- ${d}`);
  }

  out.push('', '---', PR_BODY_FOOTER);
  return out.join('\n');
}
