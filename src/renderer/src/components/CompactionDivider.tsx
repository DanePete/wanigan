import { COMPACTION_NOTE, type CompactTrigger } from '@shared/compaction';
import { num } from './bits';
import '../styles/depth.css';

/**
 * Where a conversation was compacted. Everything after this line was worked on
 * by a model holding a summary of what came before, and the divider says so in
 * words rather than leaving it to a glyph. Token counts appear only where the
 * transcript recorded them; the hook events carry none.
 */
export default function CompactionDivider({ mark, where }: {
  mark: { trigger: CompactTrigger; preTokens: number | null; postTokens: number | null; source?: 'hook+transcript' | 'hook' | 'transcript' };
  /** "after" for a page read oldest first, "above" for the Timeline, which reads newest first. */
  where: 'after' | 'above';
}) {
  const tokens = mark.preTokens !== null
    ? `${num(mark.preTokens)} tokens before${mark.postTokens !== null ? ` · ${num(mark.postTokens)} after` : ''}`
    : null;
  // The same words in both places; the Timeline reads newest first, so it says which way "after" is.
  const note = where === 'after' ? COMPACTION_NOTE : `${COMPACTION_NOTE} (newer rows are above this line)`;
  const source = mark.source === 'transcript' ? 'from the transcript; no hook row'
    : mark.source === 'hook' ? 'hook only; no token counts were recorded'
      : mark.source === 'hook+transcript' ? 'hook and transcript' : 'from the transcript';
  return (
    <div className="dp-compact" role="separator" aria-label={`Compacted: ${note}`}>
      <span className="dp-compact-rule" aria-hidden="true" />
      <span className="dp-compact-text">
        <strong>⧉ Compacted{mark.trigger ? ` · ${mark.trigger}` : ''}</strong>
        {tokens && <span className="mono"> · {tokens}</span>}
        <span> — {note}</span>
        <span className="faint dp-fine"> ({source})</span>
      </span>
      <span className="dp-compact-rule" aria-hidden="true" />
    </div>
  );
}
