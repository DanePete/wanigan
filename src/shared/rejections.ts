/**
 * Denied steps stay visible.
 *
 * A tool call the policy gate denied leaves a PreToolUse on the timeline and
 * nothing after it: the CLI never runs the tool, so no PostToolUse arrives and
 * the row read as "started, no result recorded" — or was simply counted as one
 * more failure. An auto-mode classifier denial arrives as PermissionDenied and
 * was drawn the same way. Both are decisions with a reason, and the Timeline
 * now keeps each as a row labelled "Rejected" with the rule or reason
 * (e-google.md §C22, after Antigravity 2.13: "Denied steps now stay visible
 * with a Rejected label").
 *
 * The join from a gate denial to its PreToolUse is by session, tool and time:
 * the gate decides while the PreToolUse request is open and writes its ledger
 * row in the same breath, so the two are milliseconds apart. The ledger keeps
 * no tool_use_id, and none is invented here.
 */

export type GateRejection = { at: number; toolName: string; summary: string; rule: string; reason: string };
export type Rejected = { source: 'gate' | 'classifier'; rule: string | null; reason: string | null };

/** How far after a PreToolUse its ledger row may be stamped. The gate answers inside the request's own two-second budget. */
export const REJECTION_WINDOW_MS = 3_000;

function sameCall(eventSummary: string | null, ledgerSummary: string): boolean {
  if (!eventSummary) return true;
  const a = eventSummary.replace(/…$/, '').replace(/\s+/g, ' ').trim();
  const b = ledgerSummary.replace(/…$/, '').replace(/\s+/g, ' ').trim();
  if (!a || !b) return true;
  // Both sides are clipped (the timeline at 160 characters, the ledger at 400
  // and redacted), so one being a prefix of the other is a match.
  const n = Math.min(a.length, b.length, 60);
  return a.slice(0, n) === b.slice(0, n) || a.endsWith(b.slice(-Math.min(b.length, 40))) || b.includes(a.slice(0, Math.min(a.length, 40)));
}

/**
 * Which rows were rejected: PreToolUse rows the gate denied (matched to a
 * ledger denial of the same tool within the window, each denial used once), and
 * every PermissionDenied row, whose `detail` carries the classifier's reason.
 */
export function rejectedRows(
  events: readonly { id: number; at: number; event: string; toolName: string | null; summary: string | null; detail?: string | null }[],
  denials: readonly GateRejection[],
): Map<number, Rejected> {
  const out = new Map<number, Rejected>();
  const used = new Set<number>();
  const pres = [...events].filter((e) => e.event === 'PreToolUse').sort((a, b) => a.at - b.at || a.id - b.id);
  for (const e of pres) {
    let best = -1;
    denials.forEach((d, i) => {
      if (used.has(i) || d.toolName !== e.toolName) return;
      const gap = d.at - e.at;
      if (gap < -250 || gap > REJECTION_WINDOW_MS || !sameCall(e.summary, d.summary)) return;
      if (best < 0 || Math.abs(gap) < Math.abs(denials[best].at - e.at)) best = i;
    });
    if (best >= 0) {
      used.add(best);
      out.set(e.id, { source: 'gate', rule: denials[best].rule, reason: denials[best].reason });
    }
  }
  for (const e of events) if (e.event === 'PermissionDenied') out.set(e.id, { source: 'classifier', rule: null, reason: e.detail ?? null });
  return out;
}
