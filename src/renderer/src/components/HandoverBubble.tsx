import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrbStory } from '@shared/orb-story';
import { companionSays, type CompanionSays } from '@shared/companion-says';
import type { AccountLimits } from '@shared/types';

type Phase = 'idle' | 'asking' | 'carrying';

/**
 * Wanigan saying a conversation is filling up, and offering to carry it over.
 *
 * Everything it may claim is decided in `context-handover.ts`, which inherits
 * the orb's own refusals: nothing on a window Wanigan assumed rather than
 * measured, nothing on a reading more than two minutes old, nothing from a
 * clock that ran backwards. If this ever speaks where the orb does not crowd,
 * the two have disagreed and the shared function is where that is fixed.
 *
 * It is not modal and does not take focus. A conversation at ninety percent is
 * still working, and somebody mid-turn must be able to finish it.
 */
export default function HandoverBubble({ story, onOpened, onError }: {
  story?: OrbStory;
  onOpened: (id: string, projectId?: string) => void;
  onError: (message: string) => void;
}) {
  const reading = story?.context;
  const sessionId = reading?.sessionId ?? null;
  const [says, setSays] = useState<CompanionSays | null>(null);
  const [limits, setLimits] = useState<{ at: number; limits: AccountLimits[] } | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [showing, setShowing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState<string | null>(null);
  // `showing` decides the hysteresis band, so the state function needs to know
  // what is on screen — and a stale closure would make the band flap.
  const showingRef = useRef(showing); showingRef.current = showing;

  // Limits are never polled for: reading them spends a probe, and the rule
  // that opening a view must not start one is already pinned in the suite.
  // This repeats what somebody's own visit to Usage established, or nothing.
  useEffect(() => {
    let alive = true;
    const read = () => {
      window.wanigan.usage.known()
        .then((next) => { if (alive) setLimits(next); })
        .catch(() => { if (alive) setLimits(null); });
      if (sessionId) {
        window.wanigan.sessions.list()
          .then((rows) => { if (alive) setAccountId(rows.find((r) => r.id === sessionId)?.accountId ?? null); })
          .catch(() => { if (alive) setAccountId(null); });
      }
    };
    read();
    const timer = window.setInterval(read, 20_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [sessionId]);

  useEffect(() => {
    const next = companionSays({
      reading, limits: limits?.limits ?? null, limitsAt: limits?.at ?? null,
      sessionAccountId: accountId, now: Date.now(), showingContext: showingRef.current,
    });
    setSays(next);
    setShowing(next?.kind === 'context');
  }, [reading, limits, accountId]);

  // A compaction genuinely reclaims context, so a dismissal is spent: asking
  // again after one is a new question rather than a repeat of the old one.
  const compactions = story?.compaction?.completed ?? 0;
  useEffect(() => { setDismissed(null); setNote(null); }, [compactions, sessionId]);

  const carry = useCallback(async () => {
    if (!sessionId) return;
    setPhase('asking'); setNote(null);
    try {
      await window.wanigan.handover.begin(sessionId);
      // Wait for this session's own Stop. The turn is a model call, so the
      // ceiling is generous; a turn still running when it expires is not an
      // error, and nothing is created.
      const stopped = await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => { off(); resolve(false); }, 180_000);
        const off = window.wanigan.on.sessionEvent((event) => {
          if (event.sessionId !== sessionId || event.event !== 'Stop') return;
          window.clearTimeout(timer); off(); resolve(true);
        });
      });
      if (!stopped) {
        setNote('The agent is still writing. Try again once the turn finishes.');
        return;
      }
      setPhase('carrying');
      const done = await window.wanigan.handover.finish(sessionId);
      if (done.kind === 'carried') {
        setShowing(false);
        onOpened(done.session.id, done.session.projectId);
        return;
      }
      setNote(done.reason);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase('idle');
    }
  }, [sessionId, onOpened, onError]);

  if (!says || dismissed === sessionId) return null;
  // A limit message with nowhere roomier to go can only report; the carry
  // action belongs to the context case and to a limit that has somewhere to go.
  const canCarry = says.kind === 'context' || !!says.accountId;

  return (
    <div className="handover-bubble" role="status" data-kind={says.kind}>
      <p className="handover-said">{says.said}</p>
      {says.ask && <p className="handover-ask">{says.ask}</p>}
      {note && <p className="handover-note">{note}</p>}
      <div className="handover-actions">
        {canCarry && (
          <button className="btn btn-sm btn-primary" type="button" disabled={phase !== 'idle'}
                  onClick={() => void carry()}>
            {phase === 'asking' ? 'Asking for a note…' : phase === 'carrying' ? 'Opening…' : 'Carry it across'}
          </button>
        )}
        <button className="btn btn-sm" type="button" disabled={phase !== 'idle'}
                onClick={() => setDismissed(sessionId)}>
          {canCarry ? 'Not now' : 'Got it'}
        </button>
      </div>
      {canCarry && (
        <p className="handover-why">
          The agent writes a handover note, then a new session opens with it. This one stays open.
        </p>
      )}
    </div>
  );
}
