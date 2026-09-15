import { useEffect } from 'react';
import { nextNeedingYou } from '@shared/session-triage';
import { bindingMatches, modalOpen } from '../bindings';
import { useAnnounce } from './announce';
import { appendToComposerDraft } from './Composer';

/**
 * The shell's triage chords and the notification-reply landing, rendered once
 * inside App's announce provider so every message they need reaches the polite
 * region rather than the error toast.
 *
 * Capture phase, like App's other shell chords, so a view's own listener
 * underneath cannot swallow them; bindingMatches refuses both inside a
 * terminal, because the PTY owns its keystrokes.
 */
export default function HelperShellKeys({ activeSessionId, openSession }: {
  activeSessionId: string | null;
  openSession: (id: string) => void;
}) {
  const { announce } = useAnnounce();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen()) return;
      if (bindingMatches(e, 'next-needs-you')) {
        e.preventDefault();
        e.stopPropagation();
        window.wanigan.attention.list()
          .then(async (queue) => {
            const live = new Set((await window.wanigan.sessions.list()).map((s) => s.id));
            const next = nextNeedingYou(queue.filter((a) => live.has(a.sessionId)), activeSessionId);
            if (next) openSession(next);
            else announce({ tone: 'info', text: 'Nothing needs you right now. Snoozed sessions are skipped until they wake.' });
          })
          .catch((err) => announce({ tone: 'error', text: `Could not read the attention queue: ${err instanceof Error ? err.message : String(err)}` }));
        return;
      }
      if (bindingMatches(e, 'reopen-tab')) {
        // Not stopped: nothing beneath binds ⌘⇧T (Sessions matches a bare
        // lower-case t), and letting it through is what lets probe-chords see
        // that the chord was taken.
        e.preventDefault();
        window.wanigan.helper.reopenClosed()
          .then((s) => {
            if (s) openSession(s.id);
            else announce({ tone: 'info', text: 'No closed session tab to reopen in this run.' });
          })
          .catch((err) => announce({ tone: 'error', text: err instanceof Error ? err.message : String(err) }));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [activeSessionId, announce, openSession]);

  // A reply typed into a macOS notification lands in that session's composer
  // as a draft and is never sent from here. Main already recorded the reply as
  // an operator action; replies that arrived while no window was open are
  // collected once this one mounts.
  useEffect(() => {
    const land = (sessionId: string, text: string) => {
      appendToComposerDraft(sessionId, text, 'Your reply from the notification is in the draft. Nothing is sent until you press Send.');
      announce({ tone: 'info', text: 'Your notification reply is in the session’s composer, unsent.', action: { label: 'Open', run: () => openSession(sessionId) } });
    };
    const off = window.wanigan.on.notificationReply(({ sessionId, text }) => land(sessionId, text));
    window.wanigan.helper.takeReplies()
      .then((held) => { for (const r of held) land(r.sessionId, r.text); })
      .catch(() => {});
    return () => { off(); };
  }, [announce, openSession]);

  return null;
}
