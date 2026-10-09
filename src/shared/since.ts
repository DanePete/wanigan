// "Since you looked": what agents did on a board after a moment, counted so
// that no number says more than is known. A card that went to review twice is
// one card; a session that failed is one session; and when the activity read
// was cut short, the counts are said to be at least what they show.
import type { Activity } from './model.ts';

type By = 'card' | 'session' | 'event';

interface Kind {
  verb: string;
  by: By;
  /** On the one compact line. */
  short: (n: number) => string;
  /** In the detail. */
  long: (n: number) => string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const KINDS: readonly Kind[] = [
  { verb: 'submitted for review', by: 'card', short: (n) => `${n} to review`, long: (n) => `${plural(n, 'card')} went to review` },
  { verb: 'asked', by: 'event', short: (n) => plural(n, 'question'), long: (n) => `${plural(n, 'question')} for you` },
  { verb: 'created', by: 'card', short: (n) => `${n} filed`, long: (n) => `${plural(n, 'card')} filed` },
  { verb: 'claimed', by: 'card', short: (n) => `${n} claimed`, long: (n) => `${plural(n, 'card')} claimed` },
  { verb: 'failed', by: 'session', short: (n) => `${n} failed`, long: (n) => `${plural(n, 'session')} failed` },
  { verb: 'released an expired claim', by: 'card', short: (n) => `${plural(n, 'claim')} expired`, long: (n) => `${plural(n, 'claim')} expired` },
];

export interface SinceGroup {
  verb: string;
  count: number;
  /** "2 to review", or "2+ to review" when the count is only a floor. */
  short: string;
  long: string;
  /** The cards involved, newest first, each once. */
  cardIds: string[];
}

export interface SinceSummary {
  groups: SinceGroup[];
  /** The activity read was cut before reaching `since`: every count is at least what it says. */
  partial: boolean;
}

/**
 * What agents (never the owner) did after `since`, from activity read newest
 * first and capped at `limit` entries.
 */
export function sinceSummary(activity: readonly Activity[], since: number, limit: number): SinceSummary {
  const oldest = activity[activity.length - 1];
  const partial = activity.length >= limit && !!oldest && oldest.at > since;
  const recent = activity.filter((a) => a.at > since && a.actor !== 'owner');
  const groups: SinceGroup[] = [];
  for (const kind of KINDS) {
    const hits = recent.filter((a) => a.verb === kind.verb);
    if (!hits.length) continue;
    const ids = new Set(hits.map((a) => (kind.by === 'card' ? a.cardId : kind.by === 'session' ? a.sessionId : null) ?? `event-${a.id}`));
    const count = ids.size;
    const floor = partial ? '+' : '';
    const short = kind.short(count).replace(/^(\d+)/, `$1${floor}`);
    const long = kind.long(count).replace(/^(\d+)/, partial ? 'At least $1' : '$1');
    groups.push({ verb: kind.verb, count, short, long, cardIds: [...new Set(hits.flatMap((a) => (a.cardId ? [a.cardId] : [])))] });
  }
  return { groups, partial };
}
