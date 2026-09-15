import type { ChainCheck } from '@shared/transcript-chain';
import { chainWarning } from '@shared/transcript-chain';
import { Icon, SectionHead } from './bits';
import { useDialog } from './useDialog';
import '../styles/mac-around.css';

/**
 * The resume confirmation's chain warning (helper sweep · P8). Shown only when
 * the read-only check found messages a resume may leave out. Nothing is
 * repaired: the transcript is Claude Code's file, and the choice is only
 * whether to resume it as it is.
 */

const KIND_WORDS: Record<string, string> = {
  progress: 'a message whose parent is a progress record',
  sidechain: 'a message whose parent is a subagent’s entry',
  missing: 'a message whose parent is not in the file',
};

export function ResumeChainDialog({ name, check, onClose, onResume }: {
  name: string; check: Extract<ChainCheck, { checked: true }>; onClose: () => void; onResume: () => void;
}) {
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'first' });
  return portal(
    <div {...backdropProps} className="overlay-backdrop">
      <section {...dialogProps} className="card p8-scripts" aria-label="Resume with a broken message chain?">
        <SectionHead label="Resume this conversation?" right={<button type="button" className="btn" aria-label="Cancel resume" onClick={onClose}><Icon name="x" /></button>} />
        <p><strong>{name}</strong>: {chainWarning(check)}.</p>
        <p className="p8-fine">
          Claude Code rebuilds a resumed conversation by following each message back to its parent. This transcript has{' '}
          {check.breaks === 1 ? 'a break' : `${check.breaks} breaks`} in that chain — {check.kinds.map((k) => KIND_WORDS[k] ?? k).join('; ')} — so the
          resumed agent may not see everything before {check.breaks === 1 ? 'it' : 'them'}. Claude Code 2.1.271 steps over progress records itself;
          an older version does not. Wanigan read the transcript and changed nothing in it.
        </p>
        <div className="p8-dialog-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={onResume}>Resume anyway</button>
        </div>
      </section>
    </div>,
  );
}
