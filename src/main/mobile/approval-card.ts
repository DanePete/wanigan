import { approvalDetailFor } from '../approval-explain';
import { configureApprovalCardSource, safeString } from './snapshot';
import type { MobileApprovalCard } from '../../shared/types';

/**
 * The approval explanation, cut down for a phone.
 *
 * The phone monitor's boundary keeps commands and file names off the wire, and
 * this is the one deliberate exception, made narrowly: it is attached only to a
 * session that is waiting on a permission prompt, and only while remote control
 * is on — the opt-in under which a paired device can already read the terminal
 * that prompt is printed in. What it adds is not more of the command; it is what
 * the command's alias resolves to, which the terminal does not show at all.
 *
 * Every string is rebuilt through the same sanitiser as the rest of the
 * snapshot and capped, and the lists are short: a phone card is read standing
 * up, and a forty-line script is one tap away at the Mac.
 */

const MAX_RUNS = 6;
const MAX_NAMES = 6;

export function approvalCardFor(sessionId: string, since: number): MobileApprovalCard | null {
  let detail;
  try {
    detail = approvalDetailFor(sessionId, Math.max(0, since - 60_000));
  } catch {
    return null;
  }
  if (!detail || !detail.approval.scripts.length) return null;
  const verdicts = new Set(['reversible', 'not reversible', 'cannot confirm']);
  const changes = new Set(['changed', 'unchanged', 'new since launch', 'cannot confirm']);
  return {
    scripts: detail.approval.scripts.slice(0, 2).map((s) => ({
      alias: safeString(s.alias, 160),
      manifest: safeString(s.manifest, 120),
      runs: s.steps.slice(0, MAX_RUNS).map((step) => ({
        from: safeString(step.from, 80),
        command: safeString(step.command, 200),
        depth: Math.max(0, Math.min(4, Math.trunc(step.depth) || 0)),
      })),
      moreRuns: Math.max(0, s.steps.length - MAX_RUNS),
      paths: s.paths.slice(0, MAX_NAMES).map((p) => safeString(p, 120)),
      hosts: s.hosts.slice(0, MAX_NAMES).map((h) => safeString(h, 120)),
      reversible: verdicts.has(s.reversible.verdict) ? s.reversible.verdict : 'cannot confirm',
      because: safeString(s.reversible.because[0] ?? '', 240),
      change: changes.has(s.change) ? s.change : 'cannot confirm',
      changeDetail: safeString(s.changeDetail, 240),
      notes: s.notes.slice(0, 3).map((n) => safeString(n, 240)),
    })),
  };
}

// Registered from here rather than imported by ./snapshot, the same way ./push
// reports itself: snapshot owns the wire and this module reads the database, and
// the pair importing each other would be a cycle for no gain.
configureApprovalCardSource(approvalCardFor);
