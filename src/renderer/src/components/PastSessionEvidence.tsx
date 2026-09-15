import { useState } from 'react';
import type { PastSession } from '@shared/types';
import CodePanel from './CodePanel';
import Timeline from './Timeline';
import { Segmented, ago } from './bits';
import { useDialog } from './useDialog';
import '../styles/past-evidence.css';

/**
 * The turns and the timeline of a conversation that is not running.
 *
 * Checkpoints and hook events outlive the process, and main answers
 * checkpoints:list, checkpoints:diff and the event reads for any recorded
 * session. The Code panel's Turns tab and the Timeline were only ever rendered
 * for sessions in the live list, so after a restart a finished run's turns
 * could not be reached without resuming it, and a resume is a new execution
 * with no turns of its own yet.
 *
 * Read from Recent, where the finished run is. Restoring a turn is offered
 * exactly as it is for a live session: previewed first, refused when the
 * checkout it was captured in is gone.
 */
export default function PastSessionEvidence({ session, providerLabel, onClose }: {
  session: PastSession;
  providerLabel: string;
  onClose: () => void;
}) {
  const [area, setArea] = useState<'turns' | 'timeline'>('turns');
  const [focusTurn, setFocusTurn] = useState<{ turn: number; nonce: number } | null>(null);
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'first' });
  const title = session.title ?? session.projectName;
  return portal(
    <div {...backdropProps} className={`${backdropProps.className} past-evidence-backdrop`}>
      <section {...dialogProps} className="past-evidence" aria-labelledby="past-evidence-title">
        <header className="past-evidence-head">
          <div className="past-evidence-title">
            <span className="label">Finished run · not running</span>
            <h2 id="past-evidence-title">{title}</h2>
            <p>
              {providerLabel}{session.model ? ` · ${session.model}` : ''} · started {ago(session.startedAt)}
              {session.continuationCount > 1 ? ` · the most recent of ${session.continuationCount} launches of this conversation` : ''}
            </p>
          </div>
          <button className="btn" onClick={onClose}>Close</button>
        </header>
        <Segmented label="Finished run evidence" value={area} onChange={setArea}
                   options={[{ value: 'turns', label: 'Turns' }, { value: 'timeline', label: 'Timeline' }]} />
        <div className="past-evidence-body">
          {area === 'turns' ? (
            <CodePanel key={`past-code-${session.id}`} projectPath={session.worktree ?? session.projectPath}
                       projectName={session.projectName} sessionId={session.id} initialTab="turns"
                       focusTurn={focusTurn} onFocusTurnHandled={() => setFocusTurn(null)} />
          ) : (
            <Timeline key={`past-tl-${session.id}`} sessionId={session.id}
                      onOpenTurnDiff={(turn) => { setFocusTurn({ turn, nonce: Date.now() }); setArea('turns'); }} />
          )}
        </div>
      </section>
    </div>
  );
}
