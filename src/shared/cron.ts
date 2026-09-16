// Local cron evaluation is pure; main owns storage and execution.

const BOUNDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function parseField(raw: string, i: number): Set<number> {
  const [lo, hi] = BOUNDS[i];
  // Day-of-week accepts 7 for Sunday, as vixie-cron does, so 7 is a legal input
  // even though the values this returns are 0-6. The fold to 0 happens after
  // the range is expanded: doing it first inverts "5-7" into 5-0 and collapses
  // "0-7" to Sunday alone — both silently wrong rather than rejected.
  const inputHi = i === 4 ? 7 : hi;
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in "${part}".`);
    let a = lo, b = inputHi;
    if (range !== '*') {
      const m = /^(\d+)(?:-(\d+))?$/.exec(range);
      if (!m) throw new Error(`Cannot read "${part}" as a cron field.`);
      a = Number(m[1]);
      b = m[2] !== undefined ? Number(m[2]) : (stepRaw ? inputHi : a);
    }
    if (a < lo || b > inputHi || a > b) {
      throw new Error(`"${part}" is outside ${lo}-${hi}${i === 4 ? ' (7 also means Sunday)' : ''}.`);
    }
    for (let v = a; v <= b; v += step) out.add(i === 4 ? v % 7 : v);
  }
  return out;
}

export function parseCron(expr: string): Set<number>[] {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('A cron expression needs five fields: minute hour day-of-month month day-of-week.');
  }
  return fields.map(parseField);
}

/** Next fire strictly after `from`, in local time. Null if it never matches. */
export function nextFire(expr: string, from: number = Date.now()): number | null {
  const [min, hr, dom, mon, dow] = parseCron(expr);
  if (!Number.isFinite(from)) throw new Error('The schedule start must be a finite timestamp.');
  // Round the instant, not its local fields. A local setter during the second
  // autumn hour can resolve to the first occurrence and move into the past.
  const d = new Date(Math.floor(from / 60_000) * 60_000 + 60_000);

  /**
   * Move the cursor to a wall-clock hour, reporting whether the local clock
   * jumped over an hour this schedule matches.
   *
   * On a spring-forward day the named hour does not exist and setHours()
   * normalises silently past it, so a 02:xx schedule matched nothing and lost
   * the whole day instead of running late. `true` means the gap swallowed a
   * matching hour and the cursor now sits on the first instant that does exist.
   * Autumn's duplicated hour is untouched: that hour is real both times,
   * setHours() lands on it exactly, no gap is reported, and the forward-only
   * walk still yields exactly one fire.
   */
  const toHour = (hour: number): boolean => {
    const wanted = ((hour % 24) + 24) % 24;
    d.setHours(hour, 0, 0, 0);
    for (let h = wanted; h !== d.getHours(); h = (h + 1) % 24) if (hr.has(h)) return true;
    return false;
  };

  // Four years covers every 29 February a schedule can name.
  const limit = new Date(from).getFullYear() + 4;
  let gap = false;
  while (d.getFullYear() <= limit) {
    // A repeated wall-clock minute is scheduled once, at its first occurrence.
    // Advance real instants through the repeated interval, including zones
    // whose rollback is thirty minutes rather than one hour.
    const firstOccurrence = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()).getTime();
    if (firstOccurrence < d.getTime()) { d.setTime(d.getTime() + 60_000); gap = false; continue; }
    if (!mon.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1); gap = toHour(0); continue;
    }
    // vixie-cron: when both day fields are constrained, either matching counts.
    const domAll = dom.size === 31, dowAll = dow.size === 7;
    const dayOk = domAll && dowAll ? true
      : domAll ? dow.has(d.getDay())
      : dowAll ? dom.has(d.getDate())
      : dom.has(d.getDate()) || dow.has(d.getDay());
    if (!dayOk) { d.setDate(d.getDate() + 1); gap = toHour(0); continue; }
    // The matching hour exists nowhere on this day's clock. The instant the
    // clock jumped to is the earliest moment the operator could have meant, and
    // firing an hour late beats vanishing for the day with nothing recorded.
    if (gap && d.getTime() > from) return d.getTime();
    if (!hr.has(d.getHours())) { gap = toHour(d.getHours() + 1); continue; }
    if (!min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    if (d.getTime() > from) return d.getTime();
    // Defensive monotonicity for calendar/offset transitions: no candidate
    // returned to storage may already be due at the time it was calculated.
    d.setTime(Math.max(d.getTime(), from) + 60_000);
  }
  return null;
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A cron expression nobody can read is a schedule nobody can audit. */
export function describeCron(expr: string): string {
  try {
    const f = expr.trim().split(/\s+/);
    const [mi, hh, dm, mo, dw] = f;
    const every = (v: string) => v.startsWith('*/');
    if (every(mi) && hh === '*' && dm === '*' && mo === '*' && dw === '*') {
      return `every ${mi.slice(2)} minutes`;
    }
    if (mi === '0' && every(hh) && dm === '*' && mo === '*' && dw === '*') {
      return `every ${hh.slice(2)} hours, on the hour`;
    }
    const at = /^\d+$/.test(mi) && /^\d+$/.test(hh)
      ? `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : null;
    if (at && dm === '*' && mo === '*' && dw === '*') return `every day at ${at}`;
    if (at && dm === '*' && mo === '*' && dw === '1-5') return `weekdays at ${at}`;
    if (at && dm === '*' && mo === '*' && /^\d$/.test(dw)) return `every ${DOW[Number(dw) % 7]} at ${at}`;
    if (mi === '0' && hh === '*' && dm === '*' && mo === '*' && dw === '*') return 'every hour, on the hour';
    return expr;
  } catch { return expr; }
}
