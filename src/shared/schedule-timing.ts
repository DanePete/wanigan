/** Common editor shapes only; the scheduler remains the authority on cron. */
export type ScheduleTiming = {
  repeat: 'daily' | 'weekdays' | 'weekly';
  time: string;
  weekday: number;
};

export function readScheduleTiming(cron: string): ScheduleTiming | null {
  // Recognize a deliberately small subset. Reading an existing expression
  // never rewrites it, including whitespace, Sunday 7, ranges and lists.
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(cron);
  if (!match) return null;
  const minute = Number(match[1]), hour = Number(match[2]), days = match[3];
  if (minute > 59 || hour > 23) return null;
  return {
    repeat: days === '*' ? 'daily' : days === '1-5' ? 'weekdays' : 'weekly',
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    weekday: /^\d$/.test(days) ? Number(days) : 1,
  };
}

export function cronForScheduleTiming(timing: ScheduleTiming): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(timing.time);
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  if (timing.repeat === 'weekly' && (!Number.isInteger(timing.weekday) || timing.weekday < 0 || timing.weekday > 6)) return null;
  return `${minute} ${hour} * * ${timing.repeat === 'daily' ? '*' : timing.repeat === 'weekdays' ? '1-5' : timing.weekday}`;
}
