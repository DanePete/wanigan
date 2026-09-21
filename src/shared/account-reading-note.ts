import type { AccountLimits } from './types';

/**
 * What a surface that chooses an account may say about it, from a reading a
 * visit to Usage already made. It never asks for a new one: opening a view must
 * not start an account probe. So it carries the reading's age, and says nothing
 * at all where there is no reading or nothing was reported against the login.
 *
 * It mirrors the launch gate's evidence and nothing more. The gate reads again
 * at launch and is what decides; this is a warning, written so it cannot be
 * mistaken for the decision.
 */
export type AccountReadingNote = { tone: 'warn'; text: string };

function ago(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function accountReadingNote(reading: AccountLimits | null | undefined, now: number): AccountReadingNote | null {
  if (!reading || reading.fetchedAt === null) return null;
  const reported = reading.state === 'signed-out' ? `${reading.accountLabel} had no signed-in account`
    : reading.state === 'ok' && reading.ordinaryUsageAllowed === false
      ? `${reading.accountLabel}’s provider reported that ordinary included usage is not currently allowed` : null;
  if (!reported) return null;
  return { tone: 'warn', text: `${reported} when Usage last read it, ${ago(now - reading.fetchedAt)}. `
    + 'While that holds, automatic phases on this account are refused rather than moved to another account; '
    + 'a phase you start yourself still launches. It is read again at each launch.' };
}
