import type { Session } from '@shared/types';
import { sessionName } from '@shared/session-name';
import CodePanel from './CodePanel';
import ReviewGate from './ReviewGate';
import { Note, PageHead, SectionHead } from './bits';
import { useDialog } from './useDialog';
import '../styles/session-history.css';

export default function SessionReview({ session, onClose, onSendToBatch }: {
  session: Session; onClose: () => void; onSendToBatch: (paths: string[]) => void;
}) {
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'first' });
  return portal(<div {...backdropProps}>
    <section {...dialogProps} className="modal pane session-review" aria-label="Review session work">
      <PageHead compact eyebrow="Review work" title={sessionName(session)} lead="Inspect changes and recorded command results before deciding what to keep."
        actions={<button className="btn" onClick={onClose}>Back to session</button>} />
      <div className="session-review-layout">
        <section className="session-review-changes" aria-label="Session checkout changes">
          <SectionHead label="Changes in session checkout" />
          <p className="mono faint session-history-identity">{session.worktree ?? session.projectPath}</p>
          <CodePanel projectPath={session.worktree ?? session.projectPath} projectName={session.projectName} sessionId={session.id} checkpointsSupported={session.capabilities?.hooks === true} onSendToBatch={onSendToBatch} />
        </section>
        <section className="session-review-checks" aria-label="Session checkout checks">
          <SectionHead label="Session checkout checks" />
          <p className="mono faint session-history-identity">{session.worktree ?? session.projectPath}</p>
          <Note tone="info">Commands run in this session’s checkout. Results record the commands and Git-visible content tested; they do not prove that all requested work is complete.</Note>
          <ReviewGate projectId={session.projectId} projectName={session.projectName} sessionId={session.id} />
        </section>
      </div>
    </section>
  </div>);
}
