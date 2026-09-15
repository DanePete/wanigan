import { useState } from 'react';
import type { Attention, Session, SnoozePreset } from '@shared/types';
import { SNOOZE_PRESETS } from '@shared/session-triage';
import { Mark, ago } from './bits';
import { clockAt, draftDenialRetry, openTimeline } from './attentionActions';

/**
 * What a verdict offers beyond its sentence, for the Fleet inspector.
 *
 * Each block is evidence first and a control second: the classifier's reason
 * before "Tell it to retry", the incident's own status word before its link,
 * the limit reading's age before the reset time it predicts. A control with no
 * evidence beside it is a button nobody can decide whether to press.
 */
export default function HelperVerdict({ att, session, onOpenSession }: {
  att: Attention | undefined;
  session: Session;
  onOpenSession: () => void;
}) {
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const helper = att?.helper;
  const say = (text: string) => { setFlash(text); window.setTimeout(() => setFlash((v) => (v === text ? null : v)), 5000); };

  const snooze = async (preset: SnoozePreset) => {
    setBusy(true);
    try {
      const { untilAt } = await window.wanigan.helper.snooze(session.id, preset);
      say(`Snoozed until ${clockAt(untilAt)}. A permission prompt, failure or denial wakes it sooner.`);
    } catch (e) { say(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const wake = async () => {
    setBusy(true);
    try { await window.wanigan.helper.unsnooze(session.id); say('Awake. It is back in the attention strip.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="helper-verdict">
      {helper?.denial && att && (
        <div className="helper-block" data-kind="denial">
          <Mark glyph="⊘" word="Denied by auto mode" tone="serious" />
          <p className="helper-line">
            The classifier’s reason: {helper.denial.reason ?? 'none was recorded'}
          </p>
          <p className="helper-cue">
            The retry line goes into this session’s composer as a draft: <span className="mono">{helper.denial.retryDraft}</span>
          </p>
          <div className="helper-actions">
            <button type="button" className="btn btn-sm" onClick={() => {
              if (draftDenialRetry(att)) { say('The retry line is in the composer. Open the session to read it and send.'); onOpenSession(); }
            }}>Tell it to retry</button>
            <button type="button" className="btn btn-sm" onClick={() => { openTimeline(session.id); onOpenSession(); }}>
              Open the timeline
            </button>
          </div>
        </div>
      )}

      {helper?.incident && (
        <div className="helper-block" data-kind="incident">
          <Mark glyph="!" word={`Open incident · ${helper.incident.status}`} tone="warn" />
          <p className="helper-line">{helper.incident.name}</p>
          <p className="helper-cue">
            {helper.incident.source} names {helper.incident.components.join(', ')}
            {helper.incident.impact ? ` · ${helper.incident.impact} impact` : ''} · page read {ago(helper.incident.readAt)}
          </p>
          <div className="helper-actions">
            <button type="button" className="btn btn-sm"
                    onClick={() => void window.wanigan.shell.openExternal(helper.incident!.url)}>
              Open the status page ↗
            </button>
          </div>
        </div>
      )}

      {helper?.limit && (
        <div className="helper-block" data-kind="limit">
          <Mark glyph="◷" word={helper.limit.state === 'waiting' ? 'Limit wait' : helper.limit.state === 'stopped' ? 'Limit wait stopped' : 'Limit reset'} tone="quiet" />
          <p className="helper-line">
            {helper.limit.state !== 'waiting'
              ? att?.detail
              : helper.limit.reset
                ? `Resets at ${clockAt(helper.limit.reset.resetsAt)} — ${helper.limit.reset.accountLabel} ${helper.limit.reset.scope ? `${helper.limit.reset.scope} ` : ''}${helper.limit.reset.kind} window.`
                : 'No limit reading predicts when this resets.'}
          </p>
          {helper.limit.reset && (
            <p className="helper-cue">From the limit reading taken {ago(helper.limit.reset.readAt)}. Idle and stalled are not reported while it waits.</p>
          )}
        </div>
      )}

      {helper?.spin && (
        <div className="helper-block" data-kind="spin">
          <Mark glyph="↻" word={`Spinning · ${helper.spin.count}×`} tone="warn" />
          <p className="helper-line">
            <span className="mono">{[helper.spin.tool, helper.spin.summary].filter(Boolean).join(' · ')}</span>{' '}
            returned the same result {helper.spin.count} times in {Math.round(helper.spin.windowMs / 60_000)} minutes.
          </p>
        </div>
      )}

      {helper?.questions && (
        <div className="helper-block" data-kind="question">
          <Mark glyph="?" word="Asking you a question" tone="accent" />
          {helper.questions.items.map((q, i) => (
            <div key={i} className="helper-question">
              <p className="helper-line">
                {q.header && <span className="helper-tag">{q.header}</span>}
                {q.question}
                {q.multiSelect && <span className="helper-cue"> (choose any)</span>}
              </p>
              <ol className="helper-options" aria-label={`Options for: ${q.question}`}>
                {q.options.map((o) => (
                  <li key={o.label}>
                    <span className="helper-option">{o.label}</span>
                    {o.description && <span className="helper-cue"> — {o.description}</span>}
                  </li>
                ))}
              </ol>
            </div>
          ))}
          <p className="helper-cue">{helper.questions.why}</p>
          <div className="helper-actions">
            <button type="button" className="btn btn-sm" onClick={onOpenSession}>Answer in the terminal</button>
          </div>
        </div>
      )}

      {session.status !== 'exited' && (
        <div className="helper-block" data-kind="snooze">
          {helper?.snoozedUntil ? (
            <>
              <Mark glyph="z" word={`Snoozed until ${clockAt(helper.snoozedUntil)}`} tone="quiet" />
              <div className="helper-actions">
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void wake()}>Wake now</button>
              </div>
            </>
          ) : (
            <div className="helper-actions" role="group" aria-label={`Snooze ${session.projectName}`}>
              <span className="helper-cue">Snooze</span>
              {SNOOZE_PRESETS.map((p) => (
                <button key={p.id} type="button" className="btn btn-sm" disabled={busy} onClick={() => void snooze(p.id)}>{p.word}</button>
              ))}
            </div>
          )}
        </div>
      )}
      <span className="helper-flash" role="status">{flash ?? ''}</span>
    </div>
  );
}
