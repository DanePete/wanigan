/**
 * The attention rules the helper sweep added, as pure functions of recorded
 * evidence.
 *
 * attention.ts decides *when* a rule outranks another and phrases the verdict;
 * this file decides whether the evidence for each rule is there at all. Kept
 * apart so every threshold can be held to account by `node --test` in under a
 * second, with events typed by hand, rather than by a smoke suite that has to
 * start Electron to ask whether three identical calls are three.
 *
 * Every function takes events oldest first — the order attention.ts already
 * holds them in — and a `now`, so nothing here reads a clock.
 */
import type { AccountLimits, AskedQuestion, LimitReset, SessionEvent } from './types';

/* ── auto-mode denials ───────────────────────────────────────────────── */

/**
 * How long a denial keeps a session in front of the operator. The same five
 * minutes a failure gets: long enough to walk back to the desk, short enough
 * that an hour-old refusal stops outranking a live permission prompt.
 */
export const DENIAL_WINDOW_MS = 5 * 60_000;

/**
 * The classifier's reason, in words a person reads.
 *
 * The 2.1.271 binary sends the classifier's own reason text in `reason`; the
 * published docs name the field `denial_reason` and document `"no_verdict"` as
 * the value for a call the classifier could not judge. Both spellings reach
 * this function, and the docs' sentinel is the one value worth rewording —
 * a bare `no_verdict` reads as an identifier, not an explanation.
 */
export function denialReasonWords(reason: string | null | undefined): string | null {
  const flat = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  if (!flat) return null;
  if (flat === 'no_verdict') return 'no classifier verdict';
  return flat;
}

/** Events after which a denial is no longer the newest thing worth saying. */
const DENIAL_SETTLED = new Set(['UserPromptSubmit', 'SessionStart', 'SessionEnd']);

/**
 * The newest auto-mode denial that still stands, or null.
 *
 * It stands until the operator says something (a new prompt), the session
 * restarts, the window passes, or the very same call later succeeds — which is
 * the model retrying on its own and getting through, and leaves nothing for a
 * person to do. The model carrying on with *other* work does not settle it:
 * the refused step is exactly what a busy-looking session hides.
 */
export function standingDenial(events: SessionEvent[], now: number, windowMs = DENIAL_WINDOW_MS): SessionEvent | null {
  const succeeded = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (DENIAL_SETTLED.has(e.event)) return null;
    if (e.event === 'PostToolUse' && e.ok !== false && e.inputDigest) succeeded.add(e.inputDigest);
    if (e.event !== 'PermissionDenied') continue;
    if (now - e.at > windowMs) return null;
    if (e.inputDigest && succeeded.has(e.inputDigest)) return null;
    return e;
  }
  return null;
}

/** Longest input summary a retry line quotes; the line has to stay one line. */
const RETRY_SUMMARY_MAX = 120;

/**
 * The one line "Tell it to retry" puts in the composer.
 *
 * Deliberately a message rather than the hook's `retry: true`. That return has
 * to be given while the CLI waits on the hook, inside a fifteen-second budget,
 * and a person cannot be asked and answer inside it — so faking it would mean
 * Wanigan approving on the operator's behalf. This line is theirs to send.
 */
export function retryDraft(tool: string | null, summary: string | null): string {
  const name = tool?.trim() || 'that call';
  const flat = summary ? summary.replace(/\s+/g, ' ').replace(/`/g, "'").trim() : '';
  const quoted = flat
    ? ` \`${flat.length > RETRY_SUMMARY_MAX ? `${flat.slice(0, RETRY_SUMMARY_MAX - 1)}…` : flat}\``
    : '';
  return `You may retry ${name}${quoted}: I approve it.`;
}

/* ── spinning ────────────────────────────────────────────────────────── */

/** How far back a spin is counted. */
export const SPIN_WINDOW_MS = 10 * 60_000;
/** Identical calls with identical results before it is a spin rather than a check. */
export const SPIN_MIN = 3;

/**
 * Input keys that describe a call rather than change it. Bash's `description`
 * is the model's caption for the command; two runs of `npm test` captioned
 * differently are the same call.
 */
const COSMETIC_INPUT_KEYS = new Set(['description']);

/**
 * A canonical text of a tool's input: keys sorted, strings with whitespace
 * collapsed, cosmetic keys dropped. main hashes this; nothing stores it.
 */
export function canonicalToolInput(toolName: string | null, input: unknown): string {
  return `${toolName ?? ''}\u0000${stable(input, 0)}`;
}

function stable(value: unknown, depth: number): string {
  if (depth > 8) return '…';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.replace(/\s+/g, ' ').trim());
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stable(v, depth + 1)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
      .filter((k) => !COSMETIC_INPUT_KEYS.has(k))
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
  }
  return 'null';
}

const TURN_BOUNDARY = new Set(['UserPromptSubmit', 'SessionStart', 'Stop', 'StopFailure', 'SessionEnd']);
const COMPLETED_CALL = new Set(['PostToolUse', 'PostToolUseFailure']);

export type Spin = {
  count: number;
  tool: string | null;
  summary: string | null;
  ok: boolean | null;
  first: SessionEvent;
  latest: SessionEvent;
};

/**
 * The same call, with the same input, coming back the same way, again and
 * again inside one busy turn.
 *
 * Successes count. That is the difference from the classifier's loop rule,
 * which only ever counts failures: an agent polling a status command that keeps
 * answering "pending", or re-reading a file that has not changed, is not
 * failing and is not getting anywhere either. A changed result breaks the
 * group, because a command whose output moved is a command worth re-running,
 * and only the group the newest call belongs to counts — a spin that stopped
 * is history.
 *
 * A row with no input digest is no evidence at all — it was written before the
 * digest existed, or by a provider that posts no tool input — so it is never
 * counted, rather than every such row collapsing into one "identical" group.
 */
export function spinning(
  events: SessionEvent[], now: number, windowMs = SPIN_WINDOW_MS, min = SPIN_MIN,
): Spin | null {
  const groups = new Map<string, Spin>();
  // The newest completed call decides which group is still going round. Three
  // identical polls followed by one that came back different is an agent that
  // just got its answer, not one that is stuck.
  let current: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    // A turn that ended is not busy; one that started is a new question.
    if (TURN_BOUNDARY.has(e.event)) break;
    if (now - e.at > windowMs) break;
    if (!COMPLETED_CALL.has(e.event) || !e.inputDigest) continue;
    const key = `${e.inputDigest}\u0000${e.ok === false ? 0 : 1}\u0000${e.resultDigest ?? ''}`;
    if (current === null) current = key;
    const seen = groups.get(key);
    if (seen) { seen.count += 1; seen.first = e; }
    else groups.set(key, { count: 1, tool: e.toolName, summary: e.summary, ok: e.ok, first: e, latest: e });
  }
  const spin = current === null ? undefined : groups.get(current);
  return spin && spin.count >= min ? spin : null;
}

/* ── usage-limit waits ───────────────────────────────────────────────── */

/**
 * The Notification types Claude Code sends as a limit wait ends, read out of
 * the 2.1.271 binary rather than the docs. There is no type for the wait
 * *starting*: the CLI only shows that on its own status line. What does reach
 * the hook bus at the start is the turn's StopFailure, whose `error` is
 * `rate_limit`.
 */
export const QUOTA_RESUMED = 'quota_auto_resume_fired';
export const QUOTA_STALE = 'quota_auto_resume_stale';
export const QUOTA_STOPPED = 'quota_auto_resume_disabled';
export const RATE_LIMIT_ERROR = 'rate_limit';

export type LimitState =
  | { state: 'waiting'; event: SessionEvent }
  | { state: 'reset-needs-enter'; event: SessionEvent }
  | { state: 'stopped'; event: SessionEvent }
  | { state: 'resumed'; event: SessionEvent };

/** Anything here means the session moved on from whatever limit it hit. */
const MOVED_ON = new Set([
  'UserPromptSubmit', 'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop',
  'PermissionRequest', 'SessionEnd',
]);

/**
 * Where a session stands with a usage limit, read from the newest events that
 * speak to it, or null when none do.
 *
 * `rate_limit` is also what a transient 429 carries — the CLI's own text for
 * one calls it "a temporary capacity issue" — so 'waiting' means "the turn
 * stopped on a rate limit and nothing has run since", and the verdict built on
 * it has to say exactly that rather than promise a reset.
 */
export function limitState(events: SessionEvent[]): LimitState | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'Notification') {
      if (e.detail === QUOTA_RESUMED) return { state: 'resumed', event: e };
      if (e.detail === QUOTA_STALE) return { state: 'reset-needs-enter', event: e };
      if (e.detail === QUOTA_STOPPED) return { state: 'stopped', event: e };
      continue;
    }
    if (e.event === 'StopFailure') {
      return e.detail === RATE_LIMIT_ERROR ? { state: 'waiting', event: e } : null;
    }
    if (MOVED_ON.has(e.event)) return null;
  }
  return null;
}

/**
 * Why an exited session looks like it stopped on a usage limit, or null.
 *
 * The same evidence limitState reads, but for a process that is gone: the
 * SessionEnd its exit posted is skipped rather than read as the session moving
 * on. Anything that actually ran after the limit — a prompt, a tool call, a
 * clean turn — means the limit was not how it ended.
 */
export function limitStopEvidence(events: SessionEvent[]): LimitState | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'SessionEnd') continue;
    if (e.event === 'Notification') {
      if (e.detail === QUOTA_STOPPED) return { state: 'stopped', event: e };
      if (e.detail === QUOTA_STALE) return { state: 'reset-needs-enter', event: e };
      if (e.detail === QUOTA_RESUMED) return null;
      continue;
    }
    if (e.event === 'StopFailure') return e.detail === RATE_LIMIT_ERROR ? { state: 'waiting', event: e } : null;
    if (MOVED_ON.has(e.event)) return null;
  }
  return null;
}

/**
 * The reset a limit reading predicts for one account, or null.
 *
 * Only a window at 100% is a window the session is waiting on, and when two
 * are full the later reset is the one that frees it. A reading for a different
 * account says nothing about this one; with no account recorded on the session
 * the reading is used only when it is the harness's single account.
 */
export function limitResetFor(
  limits: AccountLimits[] | null | undefined,
  accountId: string | null | undefined,
  harness: string,
  readAt: number,
  now: number,
): LimitReset | null {
  if (!limits?.length) return null;
  const sameHarness = limits.filter((l) => l.harness === harness && l.state === 'ok');
  const account = accountId
    ? sameHarness.find((l) => l.accountId === accountId)
    : sameHarness.length === 1 ? sameHarness[0] : undefined;
  if (!account) return null;
  let best: LimitReset | null = null;
  for (const w of account.windows) {
    if (w.usedPercent < 100 || w.resetsAt === null || w.resetsAt <= now) continue;
    if (!best || w.resetsAt > best.resetsAt) {
      best = { resetsAt: w.resetsAt, kind: w.kind, scope: w.scope, accountLabel: account.accountLabel, readAt };
    }
  }
  return best;
}

/* ── AskUserQuestion ─────────────────────────────────────────────────── */

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const MAX_TEXT = 300;

function text(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== 'string') return null;
  const flat = v.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The questions an AskUserQuestion call carries, bounded, or null when the
 * input is not that shape.
 *
 * Field names from the 2.1.271 binary's schema: `questions[]` of `question`,
 * `header`, `multiSelect` and `options[]` of `label` and `description`. The
 * input is agent-supplied, so every field is read defensively and clipped.
 */
export function askedQuestions(input: unknown): AskedQuestion[] | null {
  if (!input || typeof input !== 'object') return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return null;
  const out: AskedQuestion[] = [];
  // The schema allows four; a malformed entry is skipped rather than allowed
  // to use up one of the four slots a real question would have filled.
  for (const q of raw.slice(0, MAX_QUESTIONS * 4)) {
    if (out.length >= MAX_QUESTIONS) break;
    if (!q || typeof q !== 'object') continue;
    const r = q as Record<string, unknown>;
    const question = text(r.question);
    if (!question) continue;
    const options = Array.isArray(r.options)
      ? r.options.slice(0, MAX_OPTIONS).flatMap((o) => {
        if (!o || typeof o !== 'object') return [];
        const label = text((o as Record<string, unknown>).label, 80);
        return label ? [{ label, description: text((o as Record<string, unknown>).description, 160) }] : [];
      })
      : [];
    out.push({ question, header: text(r.header, 40), multiSelect: r.multiSelect === true, options });
  }
  return out.length ? out : null;
}
