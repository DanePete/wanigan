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
  // A running session holds the conversation open, and Codex cannot write one
  // rollout from two processes — the resume refuses it, rightly. So continuing
  // elsewhere ends this session first, and only after a second, explicit press.
  const [confirming, setConfirming] = useState<string | null>(null);
  const running = session.status !== 'exited';

  const read = useCallback(() => {
    window.wanigan.handoff.plan(session.id)
      .then(setPlan)
      .catch(() => setPlan(null));
  }, [session.id]);

  // Re-read on the session rather than on a timer: what changes the answer is
  // the conversation being recorded, and that happens once.
  useEffect(() => { setOpen(false); setConfirming(null); read(); }, [read]);

  /** Ends this session and resolves once it has actually exited, or throws. */
  const endAndWait = (id: string) => new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { off(); reject(new Error('This session did not end, so the conversation was not resumed a second time.')); }, 15_000);
    const off = window.wanigan.on.exit((event) => {
      if (event.sessionId !== id) return;
      window.clearTimeout(timer); off(); resolve();
    });
    window.wanigan.sessions.kill(id).catch((error) => {
      window.clearTimeout(timer); off(); reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  const move = async (accountId: string) => {
    if (running && confirming !== accountId) { setConfirming(accountId); return; }
    setBusy(accountId);
    try {
      const moved = await window.wanigan.handoff.move(session.id, accountId);
      if (running) await endAndWait(session.id);
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
      setConfirming(null);
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
                  ? (running ? 'Ending this session, then resuming…' : 'Linking and resuming…')
                  : confirming === target.accountId
                    ? 'Press again to end this session and continue there'
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
            {running && 'This session is still running; continuing elsewhere ends it first, because one conversation cannot be written from two places. '}
            The conversation stays where it is too. Nothing is copied when both
            accounts sit on one volume.
          </span>
        </span>
      )}
    </span>
  );
}
