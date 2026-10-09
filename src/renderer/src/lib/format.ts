import type { Actor, CardStatus, CardType, Provider, Session, SessionState } from '@shared/model';

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });

/** "just now", "4 min ago", "2 hr ago", "3 days ago". */
export function ago(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '';
  const s = Math.round((at - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86_400 * 14) return rtf.format(Math.round(s / 86_400), 'day');
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "12m", "3h 5m", "2d". */
export function duration(from: number, to = Date.now()): string {
  const m = Math.max(0, Math.round((to - from) / 60_000));
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

export const STATUS_LABEL: Record<CardStatus, string> = { inbox: 'Inbox', ready: 'Ready', working: 'Working', review: 'Review', done: 'Done', archived: 'Archived' };
export const TYPE_LABEL: Record<CardType, string> = { task: 'Task', bug: 'Bug', feature: 'Feature', idea: 'Idea' };
export const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', shell: 'Shell' };

export const STATE_LABEL: Record<SessionState, string> = {
  starting: 'Starting',
  working: 'Working',
  waiting: 'Waiting',
  permission: 'Needs permission',
  running: 'Running',
  ended: 'Ended',
  failed: 'Failed',
  interrupted: 'Interrupted',
  limited: 'Hit its limit',
};

/** Who did something, in words. Sessions are named by their title when known. */
export function actorName(actor: Actor, sessions?: ReadonlyMap<string, Session>): string {
  if (actor === 'owner') return 'You';
  if (actor === 'system') return 'Wanigan';
  if (actor.startsWith('phone:')) return `You, from ${actor.slice(6)}`;
  if (actor.startsWith('session:')) {
    const id = actor.slice(8);
    const s = sessions?.get(id);
    return s ? `${PROVIDER_LABEL[s.provider]} (${s.title})` : `Session ${id.slice(0, 6)}`;
  }
  return actor;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
