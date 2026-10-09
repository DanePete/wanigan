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
//
// Codex 0.155.1 (UsageLimitReachedError in protocol/src/error.rs at
// rust-v0.155.1, and the real binary's own rollout against a stand-in provider):
// - No hook says so. The turn's `task_complete` in its rollout carries
//   `codex_error_info: "usage_limit_exceeded"` and the message (codex-turns.ts).
//   That kind also covers an API key out of quota and a plan without Codex,
//   which are not limits that reset, so the message decides.
// - "You’ve hit your usage limit." (or "… usage limit for <limit>. Switch to
//   another model now,"), the plan's advice, then " Try again at <t>.", " or
//   try again at <t>.", " Try again later." or " or try again later." — or a
//   workspace's out-of-credits or spend-cap sentence, with no time.
// - <t> is this machine's local time: "11:21 AM" on the same day, else
//   "Oct 10th, 2026 11:21 AM".
import type { Account, Provider } from './model.ts';
import { parseResetAt } from './usage.ts';

/** A window at or past this share is too close to its limit to hand work to. */
export const NEAR_LIMIT_PERCENT = 90;

const HIT = /\byou(?:'|’)ve hit your\b/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The agent's words when a turn stopped on the account's usage limit, or null
 * when it stopped for anything else: Claude's StopFailure, or the failed turn
 * Wanigan read from a Codex rollout (its `codex_error_info` as `error`).
 */
export function usageLimitMessage(event: string, input: { error?: unknown; last_assistant_message?: unknown }): string | null {
  if (event !== 'StopFailure') return null;
  const text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message.trim() : '';
  if (input.error === 'rate_limit') return HIT.test(text) ? text.slice(0, 300) : null;
  if (input.error === 'usage_limit_exceeded') return codexLimitMessage(text);
  return null;
}

const CODEX_HIT = /^You[’']ve hit your usage limit\b/;
/** A workspace's limits, as Codex words them: no time, and none to wait for. */
const CODEX_WORKSPACE = new Set([
  'Your workspace is out of credits. Add credits to continue.',
  'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.',
  'You hit your spend cap set in your workspace. Increase your spend cap to continue.',
  'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.',
]);

/** Codex's message when it is the account's usage limit, or null for any other failure. */
export function codexLimitMessage(text: string): string | null {
  const t = text.trim();
  return CODEX_HIT.test(t) || CODEX_WORKSPACE.has(t) ? t.slice(0, 300) : null;
}

/**
 * When the limit in Codex's message resets, read in this machine's zone (Codex
 * formats it in its own, the same machine's): a time alone is on the day the
 * turn ended (`at`). Null when it says "later", says nothing, or says it in a
 * way that cannot be known.
 */
export function codexLimitResetsAt(message: string, at: number): number | null {
  const m = /\btry again at (.+?)\.?$/i.exec(message.trim());
  if (!m?.[1]) return null;
  const when = m[1].trim();
  const clock = (h: string, min: string, half: string): [number, number] | null => {
    const hour = Number(h);
    const minute = Number(min);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    return [(hour % 12) + (/pm/i.test(half) ? 12 : 0), minute];
  };
  const time = /^(\d{1,2}):(\d{2}) ([AP]M)$/i.exec(when);
  if (time) {
    const hm = clock(time[1] as string, time[2] as string, time[3] as string);
    if (!hm) return null;
    const d = new Date(at);
    d.setHours(hm[0], hm[1], 0, 0);
    return d.getTime();
  }
  const dated = /^([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) (\d{1,2}):(\d{2}) ([AP]M)$/i.exec(when);
  const month = dated ? MONTHS.findIndex((x) => x.toLowerCase() === (dated[1] as string).toLowerCase()) : -1;
  if (!dated || month < 0) return null;
  const hm = clock(dated[4] as string, dated[5] as string, dated[6] as string);
  const day = Number(dated[2]);
  if (!hm || day < 1 || day > 31) return null;
  return new Date(Number(dated[3]), month, day, hm[0], hm[1]).getTime();
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

/**
 * One line for a session stopped by its limit: "Hit its usage limit on Work.
 * Resets 4:10 pm." Claude waits at its prompt for Enter once the reset comes;
 * Codex's turn simply failed, so it is sent the message again.
 */
export function limitDetail(resetsAt: number | null, now = Date.now(), account?: string | null, provider?: Provider | null): string {
  const hit = `Hit its usage limit${account ? ` on ${account}` : ''}.`;
  if (resetsAt === null) return `${hit} When it resets is not known.`;
  if (resetsAt <= now) return `${hit} The limit has reset: ${provider === 'codex' ? 'send your message again in its terminal' : 'press Enter in its terminal to continue'}.`;
  return `${hit} Resets ${formatReset(resetsAt, now)}.`;
}

/**
 * Why a Codex conversation is not carried on under another account. Codex
 * 0.155.1 resumes only a thread found in its own CODEX_HOME (`codex resume
 * <path>` is refused), so it would need the rollout copied or linked into the
 * other account: then one thread id lives in two accounts, which History
 * refuses to choose between, and a link is written by two homes whose writer
 * locks do not see each other. Whether another account accepts the first's
 * encrypted reasoning cannot be known without a model call.
 */
export const CODEX_STAYS = 'A Codex conversation continues only in the account it lives in.';

/** Why a conversation cannot move to an account, or null when it can. */
export function whyNotTarget(target: Account, from: Account | null): string | null {
  if (from && target.id === from.id) return `This conversation is already on ${target.label}.`;
  if (from?.provider === 'codex') return CODEX_STAYS;
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
