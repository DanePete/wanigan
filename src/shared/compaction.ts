/**
 * Where a conversation was compacted, from the two records that say so.
 *
 * After a compaction the model no longer holds the earlier turns verbatim; it
 * holds a summary of them. Anyone reading a transcript or a timeline past that
 * point is reading a session whose memory of what came before is a paraphrase,
 * and nothing on either surface said so (c-claude-helper-tools.md §1.18).
 *
 * Two sources, each verified on this machine rather than taken from docs:
 *   · Claude Code transcript lines `{"type":"system","subtype":"compact_boundary",
 *     "compactMetadata":{"trigger","preTokens","postTokens",…},"timestamp"}` —
 *     read off a real local transcript (CLI 2.1.248) and the 2.1.271 binary,
 *     which writes `subtype:"compact_boundary"` with `compactMetadata`.
 *   · PreCompact and PostCompact hook events, whose schemas in the same binary
 *     carry `trigger: "manual" | "auto"` and nothing numeric. Token counts exist
 *     only in the transcript.
 */

export type CompactTrigger = 'auto' | 'manual' | null;

export type TranscriptBoundary = { at: number; trigger: CompactTrigger; preTokens: number | null; postTokens: number | null };

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

function trigger(v: unknown): CompactTrigger {
  return v === 'auto' || v === 'manual' ? v : null;
}

/** One transcript line, if it is a compact boundary. */
export function boundaryOf(raw: unknown): TranscriptBoundary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== 'system' || r.subtype !== 'compact_boundary') return null;
  const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : typeof r.timestamp === 'number' ? r.timestamp : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const meta = r.compactMetadata && typeof r.compactMetadata === 'object' ? r.compactMetadata as Record<string, unknown> : {};
  return { at, trigger: trigger(meta.trigger), preTokens: num(meta.preTokens), postTokens: num(meta.postTokens) };
}

export type CompactionMark = {
  at: number;
  trigger: CompactTrigger;
  preTokens: number | null;
  postTokens: number | null;
  /** The timeline row this divider sits on: the PostCompact, or a PreCompact with no PostCompact after it. Null for a transcript-only boundary. */
  eventId: number | null;
  source: 'hook+transcript' | 'hook' | 'transcript';
};

/** A PostCompact and its transcript boundary are the same compaction when this close. */
const PAIR_MS = 5 * 60_000;

/**
 * One divider per compaction. A hook pair is matched to the nearest unused
 * transcript boundary within five minutes, which adds the token counts; a
 * boundary no hook matched is a divider of its own, so a session that ran with
 * hooks off still shows where it was compacted.
 */
export function compactionMarks(
  events: readonly { id: number; at: number; event: string; summary: string | null }[],
  boundaries: readonly TranscriptBoundary[],
): CompactionMark[] {
  const ordered = [...events].sort((a, b) => a.at - b.at || a.id - b.id);
  const hookMarks: { id: number; at: number; trigger: CompactTrigger }[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    if (e.event === 'PostCompact') { hookMarks.push({ id: e.id, at: e.at, trigger: trigger(e.summary) }); continue; }
    if (e.event === 'PreCompact') {
      const next = ordered.slice(i + 1).find((x) => x.event === 'PreCompact' || x.event === 'PostCompact');
      if (!next || next.event === 'PreCompact') hookMarks.push({ id: e.id, at: e.at, trigger: trigger(e.summary) });
    }
  }
  const used = new Set<number>();
  const out: CompactionMark[] = [];
  for (const h of hookMarks) {
    let best = -1;
    boundaries.forEach((b, i) => {
      if (used.has(i) || Math.abs(b.at - h.at) > PAIR_MS) return;
      if (best < 0 || Math.abs(b.at - h.at) < Math.abs(boundaries[best].at - h.at)) best = i;
    });
    if (best >= 0) {
      used.add(best);
      const b = boundaries[best];
      out.push({ at: h.at, trigger: h.trigger ?? b.trigger, preTokens: b.preTokens, postTokens: b.postTokens, eventId: h.id, source: 'hook+transcript' });
    } else {
      out.push({ at: h.at, trigger: h.trigger, preTokens: null, postTokens: null, eventId: h.id, source: 'hook' });
    }
  }
  boundaries.forEach((b, i) => { if (!used.has(i)) out.push({ ...b, eventId: null, source: 'transcript' }); });
  return out.sort((a, b) => b.at - a.at);
}

export const COMPACTION_NOTE = 'earlier turns may be summarized after this point';
