// What a Claude account has left, parsed from `claude -p "/usage"`. Ported from
// Wanigan 1 (src/main/modules/usage-claude-limits.ts), where each rule was
// learned against the real CLI:
// - A window with nothing used prints no reset clause. That is an answer (0%),
//   not a broken format, and must parse.
// - "9pm" has no minutes; "1:29pm" does. Both are resets.
// - Reset times are resolved in the zone the CLI printed, not this machine's.
// - The reply is human text, so the parser is strict: anything it cannot read
//   is reported as unreadable, never as a number that looks fine and is wrong.

export interface LimitWindow {
  /** "session" or "week". */
  kind: string;
  /** A model the window is limited to ("Fable"), or null for all models. */
  scope: string | null;
  usedPercent: number;
  resetsAtText: string | null;
  resetsAt: number | null;
}

export interface AccountUsage {
  state: 'ok' | 'signed-out' | 'unreadable';
  windows: LimitWindow[];
  checkedAt: number;
  /** Why it is unreadable, or the CLI's own note that the figures are cached. */
  note: string | null;
}

const WINDOW_LINE = /^Current\s+(\w+)(?:\s*\(([^)]+)\))?:\s*(\d+(?:\.\d+)?)%\s+used(?:\s*·\s*resets\s+(.+?))?\s*$/;
const SIGNED_OUT = /(not logged in|please run \/login|login expired|invalid api key)/i;
const PROVIDER_AGE = /\b(?:showing\s+)?last[- ]known usage\b[^\n]*/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function zoneOffset(at: number, zone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(at);
    const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - Math.floor(at / 1000) * 1000;
  } catch {
    return null;
  }
}

/** "Oct 6 at 11:50pm (America/Chicago)" to an instant, or null when it cannot be known. */
export function parseResetAt(text: string, now = Date.now()): number | null {
  const m = /^([A-Za-z]{3})\w*\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*(?:\(([A-Za-z0-9_+\-/]+)\))?/i.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.indexOf((m[1] ?? '').toLowerCase());
  const zone = m[6];
  if (month < 0 || !zone) return null;
  const day = Number(m[2]);
  let hour = Number(m[3]) % 12;
  if ((m[5] ?? '').toLowerCase() === 'pm') hour += 12;
  const minute = m[4] === undefined ? 0 : Number(m[4]);
  const inZone = (year: number): number | null => {
    const wall = Date.UTC(year, month, day, hour, minute);
    const first = zoneOffset(wall, zone);
    if (first === null) return null;
    const second = zoneOffset(wall - first, zone); // the offset in force at the reset itself
    return second === null ? null : wall - second;
  };
  const year = new Date(now).getFullYear();
  let at = inZone(year);
  if (at !== null && at < now - 45 * 86_400_000) at = inZone(year + 1);
  return at;
}

export function parseUsage(text: string, now = Date.now()): AccountUsage {
  const windows: LimitWindow[] = [];
  for (const raw of text.split('\n')) {
    const m = WINDOW_LINE.exec(raw.trim());
    if (!m) continue;
    const scope = m[2]?.trim() ?? null;
    windows.push({
      kind: (m[1] ?? '').toLowerCase(),
      scope: !scope || /^all models$/i.test(scope) ? null : scope,
      usedPercent: Math.max(0, Math.min(100, Number(m[3]))),
      resetsAtText: m[4] ?? null,
      resetsAt: m[4] ? parseResetAt(m[4], now) : null,
    });
  }
  if (windows.length) return { state: 'ok', windows, checkedAt: now, note: PROVIDER_AGE.exec(text)?.[0].trim().slice(0, 200) ?? null };
  if (SIGNED_OUT.test(text)) return { state: 'signed-out', windows: [], checkedAt: now, note: null };
  const first = text.split('\n').map((l) => l.trim()).find((l) => l && !/^Permission allow rule/.test(l));
  return { state: 'unreadable', windows: [], checkedAt: now, note: first ? `Unexpected reply: ${first.slice(0, 160)}` : 'No reply.' };
}
