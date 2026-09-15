import { useCallback, useEffect, useState } from 'react';
import type { ScheduleCostDetail, ScheduleCostSettings } from '@shared/cost-types';
import { Note, Pill, SectionHead } from './bits';
import '../styles/cost.css';

/**
 * Two opt-ins for a headless schedule, and the evidence each one acts on.
 *
 * Admission: skip a fire when an account the run would use is under its
 * reserve of the 5-hour window, when someone typed into a session in the last
 * few minutes, or when no fresh limit reading exists. The panel says what the
 * rule would decide right now, so switching it on is never a surprise at 3am.
 *
 * Memory: the next run is told what the last runs found, inside a delimited
 * section shown here verbatim — the exact text, not a description of it.
 */
export default function ScheduleCostPanel({ scheduleId, disabled }: { scheduleId: string; disabled: boolean }) {
  const [detail, setDetail] = useState<ScheduleCostDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setDetail(await window.wanigan.cost.scheduleDetail(scheduleId)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [scheduleId]);
  useEffect(() => { setDetail(null); void load(); }, [load]);

  const save = async (patch: Partial<Omit<ScheduleCostSettings, 'scheduleId'>>) => {
    setBusy(true);
    try { await window.wanigan.cost.setScheduleSettings(scheduleId, patch); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (error && !detail) return <section className="sc-section"><SectionHead label="Admission and memory" /><Note tone="warn">{error}</Note></section>;
  if (!detail) return null;
  const s = detail.settings;
  const off = disabled || busy;
  return (
    <section className="sc-section cost-schedule" aria-label="Admission and memory">
      <SectionHead label="Admission" />
      <label className="cost-check">
        <input type="checkbox" checked={s.admission} disabled={off} onChange={(e) => void save({ admission: e.target.checked })} />
        <span>Skip a fire when the account is low, I am at the keyboard, or the limit reading is unknown</span>
      </label>
      <div className="cost-inline-fields">
        <label htmlFor={`reserve-${scheduleId}`}>Reserve of the 5-hour window</label>
        <input id={`reserve-${scheduleId}`} className="field" type="number" min={0} max={95} step={5} value={s.reservePct} disabled={off || !s.admission}
          onChange={(e) => void save({ reservePct: Number(e.target.value) })} />
        <span className="sc-fine">%</span>
        <label htmlFor={`quiet-${scheduleId}`}>Quiet period after input</label>
        <input id={`quiet-${scheduleId}`} className="field" type="number" min={0} max={240} value={s.quietMinutes} disabled={off || !s.admission}
          onChange={(e) => void save({ quietMinutes: Number(e.target.value) })} />
        <span className="sc-fine">min</span>
      </div>
      {s.admission && (detail.admissionNow
        ? <Note tone="warn">If it fired now: {detail.admissionNow}</Note>
        : <p className="sc-fine">If it fired now, it would run. Skipped fires are recorded in the history below with their reason.</p>)}

      <SectionHead label="What the last runs found" count={detail.outcomes.length} />
      <label className="cost-check">
        <input type="checkbox" checked={s.remember} disabled={off} onChange={(e) => void save({ remember: e.target.checked })} />
        <span>Tell the next run what the last runs found</span>
      </label>
      <div className="cost-inline-fields">
        <label htmlFor={`keep-${scheduleId}`}>Runs to remember</label>
        <input id={`keep-${scheduleId}`} className="field" type="number" min={1} max={20} value={s.keepRuns} disabled={off}
          onChange={(e) => void save({ keepRuns: Number(e.target.value) })} />
      </div>
      {detail.outcomes.length === 0
        ? <p className="sc-fine">No run of this schedule has finished since outcomes were recorded.</p>
        : <ol className="sc-history">{detail.outcomes.map((o) => (
          <li key={`${o.at}:${o.status}`}>
            <time dateTime={new Date(o.at).toISOString()}>{new Date(o.at).toLocaleString()}</time>
            <Pill status={o.status} />
            <p>{o.filesChanged === null ? 'Files changed not recorded' : `${o.filesChanged} files changed`}{o.excerpt ? ` — ${o.excerpt}` : ' — no result text recorded'}</p>
          </li>
        ))}</ol>}
      {s.remember && (detail.nextInjection
        ? <><p className="sc-fine">The next run’s prompt will end with this section, exactly:</p><pre className="cost-injection" tabIndex={0} aria-label="Section the next run will be given">{detail.nextInjection}</pre></>
        : <p className="sc-fine">Nothing is added yet: there are no recorded outcomes to pass on.</p>)}
      {detail.injectedFires.length > 0 && (
        <details className="cost-injected-fires">
          <summary>What recent fires were told ({detail.injectedFires.length})</summary>
          {detail.injectedFires.map((f) => (
            <div key={f.at}>
              <p className="sc-fine">{new Date(f.at).toLocaleString()} · {f.status}</p>
              <pre className="cost-injection" tabIndex={0} aria-label={`Section given to the fire at ${new Date(f.at).toLocaleString()}`}>{f.text}</pre>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
