// What an account has left of its plan's limits, as its CLI last reported them:
// one small bar per window (the session, the week, a model's own), filled by
// what is left. The same record the Usage screen reads; never guessed.
import type { AccountUsage, LimitWindow } from '@shared/usage';
import { ago } from '../lib/format';

/** "Session", "Week", or "Week · Fable" for a limit of one model's own. */
function windowName(w: LimitWindow): string {
  return `${w.kind === 'session' ? 'Session' : 'Week'}${w.scope ? ` · ${w.scope}` : ''}`;
}

/** When a limit resets: "at 3:10 PM" today, else "Thu, Oct 9, 9:00 AM". */
export function resetWords(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `at ${time}` : `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** What is left of each limit. `full` adds when each resets and when they were read. */
export function LimitsLeft({ usage, full = false }: { usage: AccountUsage | null; full?: boolean }) {
  const quiet = (text: string) => <span className="limits-left faint">{text}</span>;
  if (!usage) return quiet('Limits not read yet');
  if (usage.state === 'signed-out') return quiet('Signed out');
  if (usage.state === 'unreadable') return quiet('Could not read its limits');
  if (!usage.windows.length) return quiet('No limits reported');
  return (
    <span className={`limits-left${full ? ' full' : ''}`}>
      {usage.windows.map((w) => {
        const left = Math.max(0, Math.min(100, 100 - w.usedPercent));
        const words = left <= 0 ? 'used up' : `${Math.round(left)}% left`;
        const reset = w.resetsAt ? `resets ${resetWords(w.resetsAt)}` : w.resetsAtText ? `resets ${w.resetsAtText}` : '';
        return (
          <span key={`${w.kind}-${w.scope ?? 'all'}`} className={`limit-left${left <= 10 ? ' low' : ''}`}>
            <span className="limit-left-name">{windowName(w)}</span>
            <span className="limit-left-bar" role="meter" aria-valuenow={Math.round(left)} aria-valuemin={0} aria-valuemax={100}
              aria-label={`${windowName(w)}: ${words}${reset ? `, ${reset}` : ''}`}>
              <span style={{ width: `${left}%` }} />
            </span>
            <span className="limit-left-value">{words}</span>
            {full && reset ? <span className="limit-left-reset faint">{reset}</span> : null}
          </span>
        );
      })}
      {full ? <span className="limit-left-read faint">Read {ago(usage.checkedAt)}</span> : null}
    </span>
  );
}
