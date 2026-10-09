// When an agent's account hits its usage limit: what Claude Code said, when the
// limit resets, and which other accounts could carry the conversation on.
// Pure, so it is tested without a core.
//
// Read from the Claude Code 2.1.292 binary, not the docs:
// - StopFailure carries `error` (an enum that includes "rate_limit") and
//   `last_assistant_message`. Every 429 is "rate_limit", including "Server is
//   temporarily limiting requests (not your usage limit)" and model overload,
//   so only the CLI's own "You've hit your <limit> · resets <time>" is an
//   account limit.
// - The reset is printed as "4:10pm (America/Chicago)" when it is under a day
//   away, and "Oct 9, 4pm (America/Chicago)" when it is further.
import type { Account } from './model.ts';
import { parseResetAt } from './usage.ts';

/** A window at or past this share is too close to its limit to hand work to. */
export const NEAR_LIMIT_PERCENT = 90;

const HIT = /\byou(?:'|’)ve hit your\b/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Claude's words when a turn stopped on the account's usage limit, or null when it stopped for anything else. */
export function usageLimitMessage(event: string, input: { error?: unknown; last_assistant_message?: unknown }): string | null {
  if (event !== 'StopFailure' || input.error !== 'rate_limit') return null;
  const text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message.trim() : '';
  return HIT.test(text) ? text.slice(0, 300) : null;
}

/** When the limit in Claude's message resets, or null when it does not say in a way that can be known. */
export function limitResetsAt(message: string, now = Date.now()): number | null {
  const m = /\bresets\s+(.+?)\s*\(([A-Za-z0-9_+\-/]+)\)/i.exec(message);
  if (!m?.[1] || !m[2]) return null;
  const when = m[1].trim();
  const zone = m[2];
  const dated = /^([A-Za-z]{3})\w*\s+(\d{1,2}),?\s+(?:\d{4},?\s+)?(?:at\s+)?(\d{1,2}(?::\d{2})?\s*[ap]m)$/i.exec(when);
  if (dated) return parseResetAt(`${dated[1]} ${dated[2]} at ${dated[3]} (${zone})`, now);
  if (!/^\d{1,2}(?::\d{2})?\s*[ap]m$/i.test(when)) return null;
  // A time alone is the next time the clock in that zone reads it: today, or tomorrow.
  for (const day of [now, now + 86_400_000]) {
    const date = dayIn(day, zone);
    if (!date) return null;
    const at = parseResetAt(`${MONTHS[date.month]} ${date.day} at ${when} (${zone})`, now);
    if (at !== null && at > now - 60_000) return at;
  }
  return null;
}

/**
 * Gemini CLI 0.46 says it hit a usage limit only on its screen: no hook carries
 * it, and the chat file records the stopped turn as "[API Error: An unknown
 * error occurred.]". When a model request fails with its TerminalQuotaError,
 * useQuotaAndFallback (in its bundle) opens ProQuotaDialog with these lines,
 * in this order, and asks what to do (keep trying, switch model, stop):
 *
 *     Usage limit reached for <all Pro models | the model id>.
 *     Access resets at <h:mm AM|PM ZONE>.        (only when the API said when)
 *     /stats model for usage details
 *     /model to switch models.
 *
 * Seen rendered by the installed CLI in a terminal, against a fake Gemini API
 * on this Mac answering 429 (no model, no login). The match is that whole
 * block, word for word, after the screen's escapes, box borders and line
 * breaks are taken out; anything less is not a limit.
 */
const GEMINI_LIMIT = /Usage limit reached for (all Pro models|[\w.:-]+)\. (?:Access resets at (\d{1,2}):(\d{2}) ?([AP]M) ([A-Z][A-Za-z]{0,4}(?:[+-]\d{1,2}(?::\d{2})?)?)\. )?\/stats model for usage details \/model to switch models\./;

/**
 * What Gemini's AfterAgent hook says when its turn produced no text
 * (fireAfterAgentHookSafe): the turn the owner stopped at the limit.
 */
export const GEMINI_NO_RESPONSE = '[no response text]';

/** Terminal output as the words on screen: escapes, box borders and line breaks become single spaces. */
export function screenWords(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[()#][0-9A-Za-z]|\u001b[=>78DEHMc]/g, ' ')
    .replace(/[│┃║╭╮╰╯─━═]/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Gemini's usage-limit dialog in what its terminal drew, or null. `resetsAt`
 * is the next time this Mac's clock reads the time Gemini printed, and null
 * when it printed none, or a zone that is not this Mac's (Gemini formats it
 * in its own zone; a different one would make the time a guess).
 */
export function geminiLimit(words: string, now = Date.now()): { message: string; resetsAt: number | null; end: number } | null {
  const m = GEMINI_LIMIT.exec(words);
  if (!m) return null;
  const resetsAt = m[2] && m[3] && m[4] && m[5] ? nextLocal(Number(m[2]), Number(m[3]), m[4], m[5], now) : null;
  const message = `Usage limit reached for ${m[1]}.${m[2] ? ` Access resets at ${m[2]}:${m[3]} ${m[4]} ${m[5]}.` : ''}`;
  return { message, resetsAt, end: m.index + m[0].length };
}

function nextLocal(hour: number, minute: number, half: string, zone: string, now: number): number | null {
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const h = (hour % 12) + (half === 'PM' ? 12 : 0);
  for (const day of [0, 1]) {
    const at = new Date(now);
    at.setDate(at.getDate() + day);
    at.setHours(h, minute, 0, 0);
    if (at.getTime() < now - 60_000) continue;
    const local = new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
    return local === zone ? at.getTime() : null;
  }
  return null;
}

function dayIn(at: number, zone: string): { month: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'numeric', day: 'numeric' }).formatToParts(at);
    const month = Number(parts.find((p) => p.type === 'month')?.value) - 1;
    const day = Number(parts.find((p) => p.type === 'day')?.value);
    return month >= 0 && day > 0 ? { month, day } : null;
  } catch {
    return null;
  }
}

/** "4:10 pm", or "Oct 9, 4:10 pm" when it is more than a day away, in this machine's zone. */
export function formatReset(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP]M)$/i, (_m, x: string) => ` ${x.toLowerCase()}`);
  return at - now > 86_400_000 ? `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}` : time;
}

/** One line for a session stopped by its limit: "Hit its usage limit on Work. Resets 4:10 pm." */
export function limitDetail(resetsAt: number | null, now = Date.now(), account?: string | null): string {
  const hit = `Hit its usage limit${account ? ` on ${account}` : ''}.`;
  if (resetsAt === null) return `${hit} When it resets is not known.`;
  if (resetsAt <= now) return `${hit} The limit has reset: press Enter in its terminal to continue.`;
  return `${hit} Resets ${formatReset(resetsAt, now)}.`;
}

/** Why a conversation cannot move to an account, or null when it can. */
export function whyNotTarget(target: Account, from: Account | null): string | null {
  if (from && target.id === from.id) return `This conversation is already on ${target.label}.`;
  if (target.provider !== (from?.provider ?? 'claude')) return `${target.label} is a ${target.provider} account.`;
  if (target.signedIn === 'no') return `${target.label} is signed out.`;
  if (!target.folderOk) return `${target.label}’s folder is missing.`;
  if (from && sameLogin(target, from)) return `${target.label} is signed in as the same login as ${from.label}; they share one set of limits.`;
  const tight = tightest(target);
  if (tight && tight.usedPercent >= NEAR_LIMIT_PERCENT) return `${target.label} has used ${Math.round(tight.usedPercent)}% of its ${tight.kind} limit.`;
  return null;
}

export interface ContinueTarget {
  account: Account;
  /** What is known about its room: "session 40% used", or that it has not been read. */
  room: string;
}

/** Accounts a conversation could continue on now, the most room first. Unknown room is offered, and says so. */
export function continueTargets(accounts: readonly Account[], fromId: string | null): ContinueTarget[] {
  const from = accounts.find((a) => a.id === fromId) ?? null;
  return accounts
    .filter((a) => whyNotTarget(a, from) === null)
    .map((account) => {
      const tight = tightest(account);
      return { account, used: tight?.usedPercent ?? 101, room: tight ? `${tight.kind} ${Math.round(tight.usedPercent)}% used` : 'limits not read yet' };
    })
    .sort((a, b) => a.used - b.used)
    .map(({ account, room }) => ({ account, room }));
}

/** The limit window closest to full, across all models. A per-model window is left out: which model a session uses is not known. */
function tightest(a: Account): { kind: string; usedPercent: number } | null {
  if (a.usage?.state !== 'ok') return null;
  return [...a.usage.windows].filter((w) => !w.scope).sort((x, y) => y.usedPercent - x.usedPercent)[0] ?? null;
}

function sameLogin(a: Account, b: Account): boolean {
  const login = (x: Account): string | null => (x.signedIn === 'yes' && x.identity?.includes('@') ? x.identity.toLowerCase() : null);
  return login(a) !== null && login(a) === login(b);
}
