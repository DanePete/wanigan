import { useCallback, useEffect, useState } from 'react';
import type { AwaySummary, LimitResumeOffer, ResumeCheck, Session, SnoozePreset } from '@shared/types';
import { SNOOZE_PRESETS } from '@shared/session-triage';
import { Mark, Note, ago, usd } from './bits';
import { clockAt } from './attentionActions';
import { useDialog } from './useDialog';

/**
 * The session tab's triage surfaces: what happened while you were away, a
 * resume at the next limit reset, the warning before a second writer, and the
 * tab's own menu. Each reads recorded evidence from main and states where it
 * came from; none of them calls a model.
 */

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ── since you last looked ───────────────────────────────────────────── */

export function AwayNote({ summary, onDismiss }: { summary: AwaySummary; onDismiss: () => void }) {
  const away = Math.max(0, summary.until - summary.since);
  const minutes = Math.round(away / 60_000);
  const parts: string[] = [];
  if (summary.turnsCompleted) parts.push(plural(summary.turnsCompleted, 'turn') + ' finished');
  if (summary.filesChanged.count) {
    parts.push(`${plural(summary.filesChanged.count, 'file')} changed${summary.filesChanged.source === 'checkpoints' ? ' (from checkpoints)' : ''}`);
  }
  if (summary.failedTotal) parts.push(`${plural(summary.failedTotal, 'command')} failed`);
  if (summary.costDeltaUsd !== null) parts.push(`${usd(summary.costDeltaUsd)} reported`);
  return (
    <div className="session-away">
      <Note tone="info" onDismiss={onDismiss}>
        <span className="session-away-lead">
          Since you last looked, {minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`} ago:
        </span>{' '}
        {summary.nothingRecorded
          ? 'nothing was recorded.'
          : parts.length ? `${parts.join(' · ')}.` : 'events arrived, but no turn, file change or failed command among them.'}
        {summary.verdict && <> Now: <strong>{summary.verdict.label}</strong>.</>}
        {summary.costDeltaUsd === null && !summary.nothingRecorded && <span className="session-away-cue"> This session reports no cost.</span>}
        {summary.failedCommands.length > 0 && (
          <span className="session-away-list">
            {summary.failedCommands.map((c) => (
              <span key={`${c.at}-${c.summary}`} className="mono">✕ {c.summary ?? c.tool ?? 'a command'} · {ago(c.at)}</span>
            ))}
          </span>
        )}
        {summary.recap && (
          <span className="session-away-recap">
            <Mark glyph="✎" word="Claude's recap" tone="quiet" /> {summary.recap.text}
            <span className="session-away-cue"> — written by Claude {ago(summary.recap.at)}, not counted by Wanigan.</span>
          </span>
        )}
        <span className="session-away-cue"> Counted from this session’s hook events{summary.filesChanged.source === 'checkpoints' ? ' and checkpoints' : ''}; no model was asked.</span>
      </Note>
    </div>
  );
}

/* ── resume at the next reset ────────────────────────────────────────── */

export function LimitResumeNote({ session, onError }: { session: Session; onError: (m: string) => void }) {
  const [offer, setOffer] = useState<LimitResumeOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const read = useCallback(async (operatorSays = false) => {
    try { setOffer(await window.wanigan.helper.limitOffer(session.id, operatorSays)); }
    catch { setOffer(null); }
  }, [session.id]);
  useEffect(() => { void read(); }, [read]);

  if (!offer) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await read(Boolean(offer.evidence)); }
    catch (e) { onError(msg(e)); }
    finally { setBusy(false); }
  };

  if (!offer.evidence) {
    return (
      <div className="session-limit">
        <button type="button" className="link session-limit-ask" onClick={() => void read(true)}>
          Stopped on a usage limit? Offer a resume at the reset
        </button>
      </div>
    );
  }
  return (
    <div className="session-limit">
      <Note tone="warn">
        <span>{offer.evidence}</span>{' '}
        {offer.armed ? (
          <>
            <strong>Resumes this conversation at {clockAt(offer.armed.fireAt)}</strong>
            <span className="session-away-cue"> — a new process, recorded as a launch. {offer.armed.source}.</span>
          </>
        ) : offer.reset ? (
          <span className="session-away-cue">
            The limit reading from {ago(offer.reset.readAt)} says the {offer.reset.accountLabel} {offer.reset.scope ? `${offer.reset.scope} ` : ''}{offer.reset.kind} window resets at {clockAt(offer.reset.resetsAt)}. Nothing resumes unless you ask; if you do, Wanigan starts it a minute after the reset.
          </span>
        ) : (
          <span className="session-away-cue">{offer.note}</span>
        )}
        <span className="session-limit-actions">
          {offer.armed ? (
            <button type="button" className="btn btn-sm" disabled={busy}
                    onClick={() => void run(() => window.wanigan.helper.cancelResume(offer.armed!.id))}>
              Cancel the resume
            </button>
          ) : offer.reset && (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy}
                    onClick={() => void run(() => window.wanigan.helper.armResume(session.id, true))}>
              Resume at {clockAt(offer.reset.resetsAt + 60_000)}
            </button>
          )}
        </span>
      </Note>
    </div>
  );
}

/* ── the same conversation, twice ────────────────────────────────────── */

export function ResumeWarningDialog({ check, name, onFork, onAnyway, onClose }: {
  check: ResumeCheck;
  name: string;
  onFork: () => void;
  onAnyway: (() => void) | null;
  onClose: () => void;
}) {
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'least-destructive' });
  return portal(
    <div {...backdropProps}>
      <section {...dialogProps} className="modal session-resume-warning" aria-labelledby="resume-warning-title">
        <div className="label">Before resuming</div>
        <h2 id="resume-warning-title">“{name}” may already have a writer</h2>
        <ul className="session-resume-reasons">
          {check.liveInWanigan && (
            <li>It is open in Wanigan now as “{check.liveInWanigan.title}”. Two processes on one conversation interleave their turns into one transcript.</li>
          )}
          {check.outsideWriter && (
            <li>Its transcript was written {ago(check.outsideWriter.modifiedAt)} by a process Wanigan did not start — perhaps a terminal of your own.</li>
          )}
        </ul>
        <p className="dim">
          {check.fork.supported
            ? <>A fork starts a new conversation from this one and leaves the original untouched. {check.fork.why}</>
            : <>Wanigan cannot offer a fork here: {check.fork.why}</>}
        </p>
        <div className="session-resume-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {onAnyway && <button type="button" className="btn" onClick={onAnyway}>Resume anyway</button>}
          {check.fork.supported && (
            <button type="button" className="btn btn-primary" data-initial-focus onClick={onFork}>Resume as a fork</button>
          )}
        </div>
      </section>
    </div>,
  );
}

/* ── the tab's own menu ──────────────────────────────────────────────── */

export function TabTriageMenu({ session, snoozedUntil, onClose, onError }: {
  session: Session;
  snoozedUntil: number | null;
  onClose: () => void;
  onError: (m: string) => void;
}) {
  const act = (fn: () => Promise<unknown>) => { void fn().then(onClose, (e) => onError(msg(e))); };
  return (
    <div className="session-tab-menu" role="group" aria-label={`Triage ${session.projectName}`}>
      <button type="button" className="btn btn-sm" onClick={() => act(() => window.wanigan.helper.markUnread(session.id))}>
        Mark unread
      </button>
      {session.status !== 'exited' && (snoozedUntil ? (
        <button type="button" className="btn btn-sm" onClick={() => act(() => window.wanigan.helper.unsnooze(session.id))}>
          Wake (snoozed until {clockAt(snoozedUntil)})
        </button>
      ) : SNOOZE_PRESETS.map((p) => (
        <button key={p.id} type="button" className="btn btn-sm"
                onClick={() => act(() => window.wanigan.helper.snooze(session.id, p.id as SnoozePreset))}>
          Snooze {p.id === 'tomorrow' ? 'until tomorrow 9:00' : p.word}
        </button>
      )))}
      <span className="session-away-cue">A snoozed session leaves the attention strip until then, or until it asks, fails or is denied.</span>
    </div>
  );
}
