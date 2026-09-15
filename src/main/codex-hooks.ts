import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import { db } from './db';
import { exchangeHooksList } from './codex-hook-probe';
import { cleanupHookSettings, hookListenerState, writeObserveOnlyHookHeaders } from './hooks';
import {
  CODEX_HOOK_EVENTS, CODEX_HOOK_HEADERS_ENV, CODEX_HOOK_URL_ENV,
  codexHookConfigArgs, codexHookInput, codexVersionLabel, decideCodexHookTrust,
  type CodexHookEvent, type CodexHookTrust,
} from '../shared/codex-hooks';
import type { CodexHookDelivery, ObserveOnlyHooks, ObserveOnlyHooksReason, SessionEvent } from '../shared/types';

/**
 * Codex hook events, observed only: trust, launch and the hand-over from OSC 9.
 * shared/codex-hooks.ts holds the command, the arguments and every decision
 * about what Codex answered; codex-hook-probe.ts runs the app-server.
 *
 * Trust is asked of Codex once per binary, version and hook definition, and
 * the answer is kept in SQLite, so a restart does not start app-server again
 * for a version it already asked. Only a definite answer is kept there. A
 * probe that timed out, got no answer or could not read one says something
 * about that minute, not about the version, so it is held in memory briefly
 * and asked again after.
 *
 * A launch injects the hooks only with trust confirmed for the exact binary
 * about to run, and otherwise launches exactly as before and records why. OSC 9
 * stays the source of a session's Stop and PermissionRequest until that
 * session's own hooks deliver an event; from then on the hooks are, and the
 * moment is recorded on the session.
 *
 * None of this reaches the trust gate. Codex's hooks answer nothing, so
 * ProviderCapabilities.hooks stays false for Codex, and everything keyed on it
 * stays off.
 */

/** The spec's ceiling for one app-server run; the probe is two. */
const PROBE_TIMEOUT_MS = 10_000;
/** How long an answer about a bad minute is reused before asking again. */
const TRANSIENT_TTL_MS = 60_000;
const TRANSIENT = new Set<ObserveOnlyHooksReason>(['timeout', 'no-answer', 'parse-failure']);
const PROBE_REASONS = new Set<string>(['timeout', 'no-answer', 'parse-failure', 'hook-missing', 'trust-not-granted']);

/**
 * The hook definition, as Codex hashes it: the six `hooks.<Event>` arguments.
 * Part of the cache key, so changing the command or the event list asks Codex
 * again instead of trusting yesterday's hashes for today's hooks.
 */
export const CODEX_HOOK_DEFINITION_SHA256 = createHash('sha256').update(JSON.stringify(codexHookConfigArgs())).digest('hex');

export type CodexHookTarget = {
  /** The resolved binary a launch would run. */
  bin: string;
  /** Its `--version` line as detection read it; null when that failed. */
  version: string | null;
  /** Built in, or claimed by a local pack whose adapter proved it. */
  proven: boolean;
};

type TrustRecord = { trust: CodexHookTrust; probedAt: number; firstEventAt: number | null };

const memory = new Map<string, TrustRecord>();
const inFlight = new Map<string, Promise<TrustRecord>>();
/** Session id → when its own hooks first delivered, for the life of the process. */
const hookSources = new Map<string, number>();
/**
 * Session id → the events its hooks have delivered. The hand-over from OSC 9 is
 * per event, not per session: a session whose SessionStart hook fired has shown
 * that hooks run, not that its Stop or PermissionRequest hooks will, and turning
 * off OSC 9's Stop on the strength of a SessionStart would leave a session that
 * never reports finishing if those two did not fire.
 */
const deliveredEvents = new Map<string, Set<string>>();

const cacheKey = (bin: string, version: string) => JSON.stringify([bin, version, CODEX_HOOK_DEFINITION_SHA256]);

function stored(bin: string, version: string): TrustRecord | null {
  const row = db().prepare(`
    SELECT state, reason, detail, hashes_json, probed_at, first_event_at FROM codex_hook_trust
     WHERE bin = ? AND version = ? AND definition_sha256 = ?
  `).get(bin, version, CODEX_HOOK_DEFINITION_SHA256) as {
    state: string; reason: string | null; detail: string | null; hashes_json: string | null;
    probed_at: number; first_event_at: number | null;
  } | undefined;
  if (!row) return null;
  if (row.state === 'trusted') {
    try {
      const hashes = JSON.parse(row.hashes_json ?? '') as Record<CodexHookEvent, string>;
      // The same check a launch makes before writing a hash into TOML. A row
      // that fails it is treated as never asked, and Codex is asked again.
      codexHookConfigArgs(hashes);
      return { trust: { state: 'trusted', hashes }, probedAt: row.probed_at, firstEventAt: row.first_event_at };
    } catch { return null; }
  }
  if (row.state !== 'unavailable' || !row.reason || !PROBE_REASONS.has(row.reason)) return null;
  return {
    trust: { state: 'unavailable', reason: row.reason as Extract<CodexHookTrust, { state: 'unavailable' }>['reason'], detail: row.detail ?? '' },
    probedAt: row.probed_at, firstEventAt: null,
  };
}

function remember(bin: string, version: string, record: TrustRecord): void {
  memory.set(cacheKey(bin, version), record);
  if (record.trust.state === 'unavailable' && TRANSIENT.has(record.trust.reason)) return;
  try {
    db().prepare(`
      INSERT INTO codex_hook_trust (bin, version, definition_sha256, state, reason, detail, hashes_json, probed_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (bin, version, definition_sha256) DO UPDATE SET
        state = excluded.state, reason = excluded.reason, detail = excluded.detail,
        hashes_json = excluded.hashes_json, probed_at = excluded.probed_at
    `).run(
      bin, version, CODEX_HOOK_DEFINITION_SHA256, record.trust.state,
      record.trust.state === 'unavailable' ? record.trust.reason : null,
      record.trust.state === 'unavailable' ? record.trust.detail : null,
      record.trust.state === 'trusted' ? JSON.stringify(record.trust.hashes) : null,
      record.probedAt,
    );
  } catch { /* the answer still holds for this run; the next start asks again */ }
}

/** A cached answer, from memory or SQLite, without starting anything. */
function cached(bin: string, version: string): TrustRecord | null {
  const key = cacheKey(bin, version);
  const held = memory.get(key);
  if (held) {
    const stale = held.trust.state === 'unavailable' && TRANSIENT.has(held.trust.reason)
      && Date.now() - held.probedAt >= TRANSIENT_TTL_MS;
    if (!stale) return held;
    memory.delete(key);
  }
  let row: TrustRecord | null = null;
  try { row = stored(bin, version); } catch { /* unreadable reads as unasked */ }
  if (row) memory.set(key, row);
  return row;
}

/**
 * Codex's answer for one binary and version, asking it only when nothing is
 * cached. Launches and Settings that ask at once share one probe.
 */
export async function codexHookTrust(
  bin: string, version: string, probeEnv: NodeJS.ProcessEnv, timeoutMs = PROBE_TIMEOUT_MS,
): Promise<TrustRecord> {
  const prior = cached(bin, version);
  if (prior) return prior;
  const key = cacheKey(bin, version);
  const running = inFlight.get(key);
  if (running) return running;
  const work = (async () => {
    const trust = await decideCodexHookTrust(async (configArgs) => (await exchangeHooksList({
      bin, configArgs, env: probeEnv, timeoutMs, clientVersion: app.getVersion(),
    })).exchange);
    const record: TrustRecord = { trust, probedAt: Date.now(), firstEventAt: null };
    remember(bin, version, record);
    return record;
  })();
  inFlight.set(key, work);
  try { return await work; } finally { inFlight.delete(key); }
}

function unavailable(version: string | null, reason: ObserveOnlyHooksReason, detail: string | null = null): ObserveOnlyHooks {
  return { state: 'unavailable', version: codexVersionLabel(version), reason, detail };
}

/** The reasons that are true before Codex is asked anything. */
function precondition(target: CodexHookTarget): ObserveOnlyHooks | null {
  if (!target.proven) return unavailable(target.version, 'harness-unproven');
  const listener = hookListenerState();
  if (listener === 'off') return unavailable(target.version, 'hook-bus-off');
  if (listener === 'down') return unavailable(target.version, 'listener-down');
  if (!fs.existsSync('/bin/sh') || !fs.existsSync('/usr/bin/curl')) return unavailable(target.version, 'curl-missing');
  if (!target.version) return unavailable(target.version, 'no-version');
  return null;
}

function statusOf(target: CodexHookTarget, record: TrustRecord): ObserveOnlyHooks {
  const version = codexVersionLabel(target.version) ?? 'an unknown version';
  if (record.trust.state === 'unavailable') return unavailable(target.version, record.trust.reason, record.trust.detail);
  return record.firstEventAt !== null
    ? { state: 'observed', version, firstEventAt: record.firstEventAt }
    : { state: 'trusted', version };
}

/**
 * The capability line for one installed binary, from what is already known.
 * Null means Codex has not been asked on this version yet; nothing is started
 * to find out, because this is read on every provider detection.
 */
export function observeOnlyHooksStatus(target: CodexHookTarget): ObserveOnlyHooks | null {
  const before = precondition(target);
  if (before) return before;
  const record = cached(target.bin, target.version!);
  return record ? statusOf(target, record) : null;
}

/** The same line, asking Codex when nothing is cached. */
export async function checkObserveOnlyHooks(target: CodexHookTarget, probeEnv: NodeJS.ProcessEnv): Promise<ObserveOnlyHooks> {
  const before = precondition(target);
  if (before) return before;
  return statusOf(target, await codexHookTrust(target.bin, target.version!, probeEnv));
}

export type CodexHookLaunch = {
  /** Beside the lifecycle arguments; empty when nothing is injected. */
  args: string[];
  /** For this one PTY; empty when nothing is injected. Holds a URL and a path, never the bearer. */
  env: Record<string, string>;
  delivery: CodexHookDelivery;
};

/** `-c hooks.…` or `--config=hooks.…` among the operator's extra arguments. */
const HOOK_OVERRIDE = /(?:^|=)hooks\./;

/**
 * What one attended Codex launch adds for hook events.
 *
 * Never throws: every way this can fail is a launch without hooks and a
 * recorded reason, never a launch that did not happen. Extra arguments that
 * configure hooks themselves turn injection off, because a later `-c` for the
 * same key replaces Wanigan's hook while its trust entry stays, so neither
 * hook would run and nothing would say so.
 */
export async function prepareCodexHookLaunch(input: {
  sessionId: string;
  projectPath: string;
  target: CodexHookTarget;
  probeEnv: NodeJS.ProcessEnv;
  extraArgs: string[];
  /** Told once, when this session's first hook event arrives. */
  onSwitch?: (at: number) => void;
}): Promise<CodexHookLaunch> {
  const none = (reason: ObserveOnlyHooksReason, detail: string | null = null): CodexHookLaunch =>
    ({ args: [], env: {}, delivery: { state: 'not-injected', reason, detail } });
  if (input.extraArgs.some((arg) => HOOK_OVERRIDE.test(arg))) return none('extra-args');

  let status: ObserveOnlyHooks;
  try { status = await checkObserveOnlyHooks(input.target, input.probeEnv); }
  catch (error) { return none('no-answer', error instanceof Error ? error.message : String(error)); }
  if (status.state === 'unavailable') return none(status.reason, status.detail);
  const record = cached(input.target.bin, input.target.version!);
  if (!record || record.trust.state !== 'trusted') return none('trust-not-granted');

  let args: string[];
  try { args = codexHookConfigArgs(record.trust.hashes); }
  catch (error) { return none('launch-failed', error instanceof Error ? error.message : String(error)); }
  const { bin } = input.target;
  const version = input.target.version!;
  let headers: { file: string; url: string } | null;
  try {
    headers = writeObserveOnlyHookHeaders(input.sessionId, input.projectPath, [...CODEX_HOOK_EVENTS], {
      read: codexHookInput,
      onEvent: (event) => noteHookEvent(input.sessionId, bin, version, event, input.onSwitch),
    });
  } catch (error) {
    try { cleanupHookSettings(input.sessionId); } catch { /* nothing was registered */ }
    return none('launch-failed', error instanceof Error ? error.message : String(error));
  }
  // The listener can stop between the check above and the write.
  if (!headers) return none(hookListenerState() === 'off' ? 'hook-bus-off' : 'listener-down');
  return {
    args,
    env: { [CODEX_HOOK_URL_ENV]: headers.url, [CODEX_HOOK_HEADERS_ENV]: headers.file },
    delivery: { state: 'injected', version: codexVersionLabel(version) ?? version, switchedAt: null },
  };
}

/**
 * The first event a session's own hooks deliver is two facts. For the session,
 * its hooks are now the source and OSC 9 is not recorded again. For the
 * version, a real session has delivered, which is the only thing that lets
 * Settings say "observed". Both are written where a restart can read them.
 */
function noteHookEvent(
  sessionId: string, bin: string, version: string, event: SessionEvent, onSwitch?: (at: number) => void,
): void {
  const delivered = deliveredEvents.get(sessionId) ?? new Set<string>();
  delivered.add(String(event.event));
  deliveredEvents.set(sessionId, delivered);
  if (hookSources.has(sessionId)) return;
  const at = event.at;
  hookSources.set(sessionId, at);
  try {
    db().prepare(`
      UPDATE session_log SET codex_hooks_json = json_set(codex_hooks_json, '$.switchedAt', ?)
       WHERE id = ? AND codex_hooks_json IS NOT NULL AND json_valid(codex_hooks_json)
    `).run(at, sessionId);
  } catch { /* the live session record, told below, still carries it */ }
  try {
    db().prepare(`
      UPDATE codex_hook_trust SET first_event_at = ?, first_event_session = ?
       WHERE bin = ? AND version = ? AND definition_sha256 = ? AND first_event_at IS NULL
    `).run(at, sessionId, bin, version, CODEX_HOOK_DEFINITION_SHA256);
  } catch { /* the in-memory answer below still says it for this run */ }
  const held = memory.get(cacheKey(bin, version));
  if (held && held.firstEventAt === null) held.firstEventAt = at;
  try { onSwitch?.(at); } catch { /* bookkeeping must not cost the event */ }
}

/** Whether this session's own hooks have delivered anything at all. */
export function codexHooksAreSource(sessionId: string): boolean {
  return hookSources.has(sessionId);
}

/**
 * Whether this session's hooks have delivered this event, so the OSC 9 or
 * Enter-typed stand-in for it is no longer recorded. Asked per event: see
 * deliveredEvents.
 */
export function codexHookDelivered(sessionId: string, event: 'Stop' | 'PermissionRequest' | 'UserPromptSubmit'): boolean {
  return deliveredEvents.get(sessionId)?.has(event) === true;
}

/** At exit; the recorded switch on the session row is unaffected. */
export function forgetCodexHookSession(sessionId: string): void {
  hookSources.delete(sessionId);
  deliveredEvents.delete(sessionId);
}

/**
 * Forgets the in-memory answers, as a restart would. SQLite is untouched, so
 * the next question is answered from there. For the smoke suite.
 */
export function dropCodexHookTrustMemory(): void {
  memory.clear();
}
