import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@shared/types';
import type { HandoffPlan } from '@shared/handoff';

/**
 * Continue this conversation on another account.
 *
 * An account is a CODEX_HOME, and Codex files a conversation into the home it
 * was launched under — so when the account you are on runs out of usage, the
 * thread is not merely paused, it is invisible to the account that still has
 * usage left. This links the one conversation into that account's home and
 * resumes it there.
 *
 * It renders nothing unless main says there is somewhere to go. The plan comes
 * back with a reason when there is not — one account, no recorded conversation,
 * a rollout it could not find — and a control that cannot work is worse than no
 * control, so the reason is shown only while the menu is open and asked for.
 */
export default function SessionHandoff({ session, onOpened, onError }: {
  session: Session;
  onOpened: (id: string, projectId?: string) => void;
  onError: (message: string) => void;
}) {
  const [plan, setPlan] = useState<HandoffPlan | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const read = useCallback(() => {
    window.wanigan.handoff.plan(session.id)
      .then(setPlan)
      .catch(() => setPlan(null));
  }, [session.id]);

  // Re-read on the session rather than on a timer: what changes the answer is
  // the conversation being recorded, and that happens once.
  useEffect(() => { setOpen(false); read(); }, [read]);

  const move = async (accountId: string) => {
    setBusy(accountId);
    try {
      const moved = await window.wanigan.handoff.move(session.id, accountId);
      const next = await window.wanigan.sessions.create({
        providerId: session.providerId,
        projectId: session.projectId,
        accountId,
        resumeFrom: { sessionId: session.id, conversationId: moved.threadId },
      });
      setOpen(false);
      onOpened(next.id, next.projectId);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const targets = plan?.targets ?? [];
  if (!plan || targets.length === 0) return null;

  return (
    <span className="session-handoff">
      <button className="faint session-status-action session-handoff-open" type="button"
              aria-expanded={open} aria-haspopup="menu"
              onClick={() => setOpen((was) => !was)}>
        ⇄ continue on…
      </button>
      {open && (
        <span className="session-handoff-menu" role="menu">
          {targets.map((target) => (
            <button key={target.accountId} type="button" role="menuitem"
                    className="session-handoff-item" disabled={busy !== null}
                    onClick={() => void move(target.accountId)}>
              <span className="session-handoff-label">{target.label}</span>
              <span className="session-handoff-why">
                {busy === target.accountId
                  ? 'Linking and resuming…'
                  : target.alreadyThere
                    ? 'Already readable there — resumes straight away'
                    : 'Links this conversation into that account, then resumes it'}
              </span>
            </button>
          ))}
          {/* The source is never moved or removed, and that is the point: the
              account this started on is usually out of usage for a while, not
              for good, and can still continue it afterwards. */}
          <span className="session-handoff-note">
            The conversation stays where it is too. Nothing is copied when both
            accounts sit on one volume.
          </span>
        </span>
      )}
    </span>
  );
}
