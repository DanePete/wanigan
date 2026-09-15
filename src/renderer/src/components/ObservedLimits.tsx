import {
  forecastSentence, WINDOW_LABELS, type ObservedAccount, type ObservedLimitsReport, type ObservedWindow,
} from '@shared/status-line';
import { Mark, ago } from './bits';

/**
 * What an account's own sessions' status lines said about its limits, beside
 * the /usage probe card and never merged into it.
 *
 * The two are different instruments. The probe asks the CLI on request and
 * reads its words back; this is what a running session was told by the
 * provider on its last response, relayed as it drew its status line. Each
 * figure here says where it came from and how old it is, a window the CLI did
 * not send is not drawn at all, and a forecast is offered only when the
 * readings can carry one — otherwise the sentence says why not.
 */

/** "14:40", or "Sat 09:00" when the time is not today — a seven-day reset is days away. */
function clock(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString()
    ? time
    : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function tone(percent: number): string {
  if (percent >= 95) return 'u-ow-fill is-critical';
  if (percent >= 75) return 'u-ow-fill is-warning';
  return 'u-ow-fill';
}

function Window({ window: w, now }: { window: ObservedWindow; now: number }) {
  const at = (t: number) => clock(t, now);
  const shown = Math.max(0, Math.min(100, w.usedPercent));
  const newest = w.jumps[0] ?? null;
  return (
    <div className="u-ow">
      <div className="u-ow-row">
        <span className="u-ow-name">{WINDOW_LABELS[w.kind]}</span>
        <span className="u-ow-pct mono">
          {w.usedPercent >= 100 ? <Mark glyph="■" word="used up" tone="serious" /> : `${w.usedPercent}% used`}
        </span>
      </div>
      {/* Geometry as SVG attributes: the bar's length is data, not styling. */}
      <svg className="u-ow-meter" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
        <rect className="u-ow-track" x="0" y="0" width="100" height="4" />
        <rect className={tone(w.usedPercent)} x="0" y="0" width={shown} height="4" />
      </svg>
      <p className="u-ow-line">
        Observed from a live session’s status line, {ago(w.observedAt)} · resets {at(w.resetsAt)} (observed)
      </p>
      <p className="u-ow-line u-ow-forecast">{forecastSentence(w.forecast, at, ago)}</p>
      {newest && (
        <p className="u-ow-line u-ow-jump">
          <Mark glyph="▲" word="sudden jump" tone="warn" />{' '}
          {newest.fromPercent}% → {newest.toPercent}% between readings at {at(newest.fromAt)} and {at(newest.toAt)}.
          Something these readings did not see spent it — another machine, claude.ai, a session outside Wanigan —
          or the limit changed; the forecast is drawn straight through the step.
          {w.jumps.length > 1 ? ` ${w.jumps.length - 1} earlier jump${w.jumps.length === 2 ? '' : 's'} in this window.` : ''}
        </p>
      )}
    </div>
  );
}

/** Why an account has no reading, in the order a person would fix it. */
function silence(report: ObservedLimitsReport): string {
  if (report.unsupported) return report.unsupported;
  if (!report.hooksEnabled) return 'The hook bus is off, and the status line relay rides its settings file, so no session sends readings.';
  if (!report.relayEnabled) return 'Status line readings are off in Settings › Privacy & data, so new sessions send none.';
  return 'No session on this account has sent a status line reading yet. A session Wanigan launches sends one each time the CLI draws its status line — '
    + 'unless its workspace is untrusted, its settings disable hooks, or a managed policy sets a status line of its own.';
}

export function ObservedLimits({ label, account, report, error }: {
  /** The account's name as the card beside this states it; the report may have no entry to take it from. */
  label: string;
  /** Undefined when the report has no entry for this account. */
  account: ObservedAccount | undefined;
  report: ObservedLimitsReport | null;
  error: string | null;
}) {
  const now = Date.now();
  return (
    <section className="u-observed" aria-label={`Observed limits · ${label}`}>
      <div className="u-observed-head">
        <span className="label">Observed · status line</span>
        {account && account.readings > 0 && (
          <span className="faint mono">
            {account.readings.toLocaleString('en-US')} reading{account.readings === 1 ? '' : 's'}
            {account.cliVersion ? ` · CLI ${account.cliVersion}` : ''}
          </span>
        )}
      </div>
      {error ? (
        <p className="u-ow-line"><Mark glyph="✕" word="could not read" tone="serious" /> {error}</p>
      ) : !report ? (
        <p className="u-ow-line">Reading status line observations…</p>
      ) : !account || account.readings === 0 ? (
        <p className="u-ow-line">{silence(report)}</p>
      ) : account.windows.length === 0 ? (
        <p className="u-ow-line">
          Its sessions’ status lines carried no limit windows (newest {ago(account.latestAt)}). An API-key login has
          none, and a subscription reports them only after a session’s first response. Nothing is estimated in their place.
        </p>
      ) : (
        account.windows.map((w) => <Window key={w.kind} window={w} now={now} />)
      )}
    </section>
  );
}
