/**
 * What the companion may say, and which one thing it says.
 *
 * A companion with four opinions at once is a notification tray with a face.
 * So this is a single ranked decision: every candidate message is derived here,
 * the most useful one wins, and the surface renders exactly that. Adding a new
 * thing Wanigan can say means adding a candidate and a rank, not another
 * component competing for the same corner.
 *
 * The ranking is by what the operator loses by not hearing it. A limit that has
 * already been reached blocks work outright; a window filling up is a choice
 * about when to wrap, and can wait.
 *
 * Every candidate obeys the same rule the orb does: nothing is said that
 * Wanigan did not measure. The two inputs here are a context reading, whose
 * refusals live in context-handover.ts, and account limits, which carry their
 * own `state` saying whether the number is knowledge or an apology.
 */
import { handoverState, handoverMessage, HANDOVER_INVITATION } from './context-handover.ts';
import type { ContextReading } from './orb-story.ts';
import type { AccountLimits } from './types.ts';

export type SaysKind = 'limit' | 'context';

export type CompanionSays = {
  kind: SaysKind;
  /** The observation. Always a measured fact. */
  said: string;
  /** What Wanigan proposes doing about it, or null when it can only report. */
  ask: string | null;
  /** The account a limit message is about, for a surface offering to switch. */
  accountId?: string;
};

/** At or past this much of a window, a limit is worth interrupting for. */
export const LIMIT_AT = 90;

/**
 * A limits snapshot older than this is not repeated.
 *
 * Limits are only ever read when somebody visits Usage or refreshes
 * deliberately — polling for them would spend a probe — so what is in hand can
 * be arbitrarily old. Quoting a percentage from an hour ago as though it were
 * current is the same error as quoting an assumed context window.
 */
export const LIMITS_FRESH_FOR_MS = 10 * 60_000;

function usableWindows(account: AccountLimits) {
  // 'ok' is the only state whose numbers are knowledge. 'stale', 'unreadable',
  // 'signed-out' and 'unsupported' each carry a reason, and a reason is not a
  // percentage.
  return account.state === 'ok' ? account.windows : [];
}

/** The account a session runs as, at or past the limit worth speaking about. */
function pressedWindow(limits: readonly AccountLimits[], accountId: string | null) {
  if (!accountId) return null;
  const account = limits.find((row) => row.accountId === accountId);
  if (!account) return null;
  const worst = usableWindows(account)
    .filter((window) => Number.isFinite(window.usedPercent))
    .sort((a, b) => b.usedPercent - a.usedPercent)[0];
  return worst && worst.usedPercent >= LIMIT_AT ? { account, window: worst } : null;
}

/** Another account of the same agent with materially more room. */
export function roomierAccount(
  limits: readonly AccountLimits[],
  account: AccountLimits,
  pressedPercent: number,
): AccountLimits | null {
  const candidates = limits.filter((row) =>
    row.accountId !== account.accountId
    && row.harness === account.harness
    && row.state === 'ok'
    && usableWindows(row).length > 0);
  for (const row of candidates) {
    const worst = Math.max(...usableWindows(row).map((window) => window.usedPercent));
    // Twenty points, so a swap is worth making rather than a lateral move into
    // an account that is nearly as full.
    if (worst <= pressedPercent - 20) return row;
  }
  return null;
}

/**
 * The one thing to say, or nothing.
 *
 * `showingContext` is what the surface is already displaying, which the context
 * band needs in order to be hysteresis rather than a pair of thresholds.
 */
export function companionSays(input: {
  reading: ContextReading | undefined;
  limits: readonly AccountLimits[] | null;
  limitsAt: number | null;
  sessionAccountId: string | null;
  now: number;
  showingContext: boolean;
}): CompanionSays | null {
  const { reading, limits, limitsAt, sessionAccountId, now, showingContext } = input;

  const limitsFresh = limits !== null && limitsAt !== null && now - limitsAt <= LIMITS_FRESH_FOR_MS;
  if (limitsFresh) {
    const pressed = pressedWindow(limits, sessionAccountId);
    if (pressed) {
      const { account, window } = pressed;
      const scope = window.scope ? `${window.scope} ` : '';
      const resets = window.resetsAtText ? ` It resets ${window.resetsAtText}.` : '';
      const roomier = roomierAccount(limits, account, window.usedPercent);
      return {
        kind: 'limit',
        said: `${account.accountLabel} is at ${Math.floor(window.usedPercent)}% of its ${scope}${window.kind} limit.${resets}`,
        ask: roomier ? `${roomier.accountLabel} has room. Carry the work there?` : null,
        accountId: roomier?.accountId,
      };
    }
  }

  if (reading && handoverState(reading, now, showingContext) === 'suggest') {
    const matched = !reading.note.includes('match unconfirmed');
    return { kind: 'context', said: handoverMessage(reading, matched), ask: HANDOVER_INVITATION };
  }

  return null;
}
