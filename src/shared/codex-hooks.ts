/**
 * Codex hook events, observed only: the part that needs no process.
 * src/main/codex-hooks.ts runs Codex's app-server and the session launch, and
 * hands the bytes here.
 *
 * What this is. Codex sessions used to report status only through two OSC 9
 * terminal notifications. Codex 0.154.0 has a real hook system, so Wanigan
 * injects its own hooks into each Codex PTY session through `--config`, where
 * they forward each event to the same loopback listener Claude sessions post
 * to. They observe only: the command prints nothing and always exits 0, so it
 * can never allow, deny, block or rewrite anything Codex does, and the trust
 * gate does not cover Codex because of it.
 *
 * Why trust is the hard part. Codex runs an injected hook only once it is
 * trusted, and trust is recorded per hook as `hooks.state.<key>.trusted_hash`.
 * The one flag that skips trust skips it for every hook in the invocation,
 * including the repository's own, so it is never used. Instead the same
 * `--config` layer that defines Wanigan's hooks also trusts them, by the hash
 * Codex itself reports over `hooks/list`. A hash names content, so the trust
 * covers exactly the command below and nothing a repository could put in its
 * place. The hash algorithm was not reproduced; it is only ever read back.
 *
 * Verified against Codex 0.154.0's app-server, with a throwaway CODEX_HOME:
 *  - a `-c hooks.Stop=[…]` hook lists with `source: "sessionFlags"` and key
 *    `/<session-flags>/config.toml:stop:0:0`, and reads `untrusted`;
 *  - the same invocation plus `hooks.state={"<that key>"={trusted_hash="<its
 *    hash>"}}` reads `trusted`, and a different command at that key reads
 *    `modified`.
 * Not verified: that the hooks fire in a real turn, what each payload carries,
 * and whether the command inherits Codex's environment. Nothing here claims
 * any of them; the first event a real session delivers is what answers them.
 */
import type { HookInput, ObserveOnlyHooks, ObserveOnlyHooksReason } from './types.ts';

/**
 * The six events Wanigan asks Codex for. Codex 0.154.0 also names PreCompact,
 * PostCompact, SessionEnd, SubagentStart and SubagentStop; they are left out
 * until one of these six has been seen to arrive, because every injected hook
 * needs its own trust entry and none of them is yet read by anything Codex
 * sessions show.
 */
export const CODEX_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop',
] as const;
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

/** The listener URL, set on the one PTY whose hooks post to it. */
export const CODEX_HOOK_URL_ENV = 'WANIGAN_CODEX_HOOK_URL';
/** The path of that session's 0600 headers file, which holds its bearer. */
export const CODEX_HOOK_HEADERS_ENV = 'WANIGAN_CODEX_HOOK_HEADERS';

/**
 * The forwarding command. One string for every session, because Codex trusts
 * a hook by the hash of its content: anything per-session in here, a port or
 * a bearer, would change the hash on every launch and need a fresh probe.
 *
 * Each part, and the failure it prevents:
 *  - `/bin/sh -c '…; exit 0'`: Codex may hand a command string to a shell or
 *    split it into argv, and this spelling runs the same script either way.
 *    `exit 0` is last so a refused connection, a closed Wanigan or a timeout
 *    can never read as a failed or blocking hook.
 *  - `/usr/bin/curl`, by absolute path: the hook's PATH is unverified, and a
 *    repository can put its own `curl` ahead of the system one on a PATH.
 *  - `-q`, first because curl only honours it there: without it curl reads
 *    `~/.curlrc`, where a `trace` or `proxy` line would copy the bearer to a
 *    file or a host.
 *  - `--noproxy "*"`: curl 8.7.1 on the machine this was written on sent a
 *    POST for 127.0.0.1 through `http_proxy` from the environment. An
 *    inherited proxy would otherwise receive the bearer and the event.
 *  - `-sS`: no progress meter. Errors would print, but see the redirect.
 *  - `--max-time 5`: a hook that waits holds up Codex's turn. The listener
 *    answers within its own two-second budget, so five is only ever reached
 *    when something is wrong, and then the turn loses five seconds, not more.
 *  - `-H @"$WANIGAN_CODEX_HOOK_HEADERS"`: headers are read from the session's
 *    0600 file, so the bearer is never in argv (which `ps` shows), never in
 *    this command (which Codex lists and hashes) and never in an environment
 *    value (which every tool the agent runs inherits).
 *  - `--data-binary @-`: the event arrives on stdin and is posted byte for
 *    byte; `-d` would strip its newlines.
 *  - `>/dev/null 2>&1`: what Codex does with a hook's output is unverified, and
 *    a printed reply could be read as a decision. Printing nothing is what
 *    keeps the hook an observer under any reading.
 */
export const CODEX_HOOK_COMMAND =
  `/bin/sh -c '/usr/bin/curl -q -sS --noproxy "*" --max-time 5 -H @"$${CODEX_HOOK_HEADERS_ENV}" `
  + `--data-binary @- "$${CODEX_HOOK_URL_ENV}" >/dev/null 2>&1; exit 0'`;

/** The layer Codex files `-c` overrides under, exactly as it names it. */
export const CODEX_SESSION_FLAGS_LAYER = '/<session-flags>/config.toml';

const HASH = /^sha256:[0-9a-f]{64}$/;

function snakeCase(event: string): string {
  return event.replace(/[A-Z]/g, (letter, at: number) => `${at ? '_' : ''}${letter.toLowerCase()}`);
}

/**
 * The key Codex lists a Wanigan hook under, and the key its trust is recorded
 * against: `<layer>:<snake_event>:<group index>:<handler index>`. Each event
 * is given one group holding one handler, so both indexes are always zero.
 */
export function codexHookKey(event: CodexHookEvent): string {
  return `${CODEX_SESSION_FLAGS_LAYER}:${snakeCase(event)}:0:0`;
}

/**
 * The `--config` arguments that define Wanigan's hooks, and trust them when
 * given the hash Codex reported for each.
 *
 * Values are TOML, and every string is written with JSON.stringify: for the
 * printable ASCII these hold, a JSON string is also a valid TOML basic string,
 * which is how developer_instructions is already passed. A hash is checked
 * before it is written, because a stored one comes back out of SQLite and a
 * quote in it would be a TOML injection into the agent's own configuration.
 *
 * Trust is all six or none. A partly trusted set would deliver some events and
 * not others, and a session that has delivered any stops recording OSC 9.
 */
export function codexHookConfigArgs(trusted?: Readonly<Record<CodexHookEvent, string>>): string[] {
  const handler = `{type="command",command=${JSON.stringify(CODEX_HOOK_COMMAND)}}`;
  const args: string[] = [];
  for (const event of CODEX_HOOK_EVENTS) args.push('--config', `hooks.${event}=[{hooks=[${handler}]}]`);
  if (!trusted) return args;
  const entries = CODEX_HOOK_EVENTS.map((event) => {
    const hash = trusted[event];
    if (typeof hash !== 'string' || !HASH.test(hash)) {
      throw new Error(`Codex's hash for Wanigan's ${event} hook is not a sha256 digest, so it was not trusted.`);
    }
    return `${JSON.stringify(codexHookKey(event))}={trusted_hash=${JSON.stringify(hash)}}`;
  });
  args.push('--config', `hooks.state={${entries.join(',')}}`);
  return args;
}

/**
 * A hook event name as Wanigan stores it, from whichever spelling Codex used.
 * `hooks/list` names events in camelCase and the config key in PascalCase;
 * the payload's spelling is unverified, so snake_case is accepted too. A name
 * that is not an identifier comes back null rather than stored as text.
 */
export function codexEventName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(trimmed)) return null;
  return trimmed.split('_').filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join('');
}

function codexHookEvent(raw: unknown): CodexHookEvent | null {
  const name = codexEventName(raw);
  return (CODEX_HOOK_EVENTS as readonly string[]).includes(name ?? '') ? name as CodexHookEvent : null;
}

export type CodexHookEntry = {
  event: CodexHookEvent;
  key: string;
  hash: string;
  /** Codex's own word: managed, untrusted, trusted or modified. */
  trust: string;
  /** Null when Codex did not say. */
  enabled: boolean | null;
};

export type CodexHookListing =
  | { ok: true; entries: Record<CodexHookEvent, CodexHookEntry>; others: number }
  | { ok: false; reason: 'parse-failure' | 'hook-missing'; detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clipped = (text: string, max = 200): string => {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Wanigan's own hooks, out of one `hooks/list` response.
 *
 * A hook is Wanigan's only when Codex says it came from the session-flags
 * layer, runs as a command and runs exactly the forwarding command. Anything
 * else is someone else's — the operator's, the repository's, a managed one —
 * and is counted, never picked, even when it shares an event or copies the
 * command. Picked entries must then sit at the key Wanigan derives, carry a
 * sha256 hash, and appear once: a trust entry is written against that key, and
 * trusting a hash read from anywhere else would trust whatever sits there.
 */
export function readCodexHookList(response: unknown): CodexHookListing {
  const fail = (detail: string): CodexHookListing => ({ ok: false, reason: 'parse-failure', detail });
  if (!isRecord(response)) return fail('Codex answered hooks/list with something that is not a JSON object.');
  if (isRecord(response.error)) {
    const message = typeof response.error.message === 'string' ? response.error.message : 'no message';
    return fail(`Codex refused hooks/list: ${clipped(message)}`);
  }
  const result = response.result;
  if (!isRecord(result) || !Array.isArray(result.data)) return fail('Codex\'s hooks/list answer has no data list.');

  const found = new Map<CodexHookEvent, CodexHookEntry>();
  let others = 0;
  /** Codex's own complaints, which is where a hook it refused to load is explained. */
  const complaints: string[] = [];
  for (const scope of result.data) {
    if (!isRecord(scope) || !Array.isArray(scope.hooks)) return fail('A hooks/list scope has no hooks list.');
    for (const error of Array.isArray(scope.errors) ? scope.errors : []) {
      const text = typeof error === 'string' ? error : isRecord(error) && typeof error.message === 'string' ? error.message : null;
      if (text) complaints.push(clipped(text, 160));
    }
    for (const hook of scope.hooks) {
      if (!isRecord(hook)) return fail('A hooks/list entry is not a JSON object.');
      const event = codexHookEvent(hook.eventName);
      const ours = hook.source === 'sessionFlags' && hook.handlerType === 'command' && hook.command === CODEX_HOOK_COMMAND;
      if (!ours || !event) { others++; continue; }
      const key = hook.key;
      const hash = hook.currentHash;
      if (key !== codexHookKey(event)) {
        return fail(`Codex listed Wanigan's ${event} hook under ${typeof key === 'string' ? clipped(key, 120) : 'no key'}, not ${codexHookKey(event)}.`);
      }
      if (typeof hash !== 'string' || !HASH.test(hash)) return fail(`Codex's hash for Wanigan's ${event} hook is not a sha256 digest.`);
      if (typeof hook.trustStatus !== 'string') return fail(`Codex gave no trust status for Wanigan's ${event} hook.`);
      const entry: CodexHookEntry = {
        event, key, hash, trust: hook.trustStatus,
        enabled: typeof hook.enabled === 'boolean' ? hook.enabled : null,
      };
      const prior = found.get(event);
      if (prior && (prior.hash !== entry.hash || prior.trust !== entry.trust || prior.enabled !== entry.enabled)) {
        return fail(`Codex listed Wanigan's ${event} hook twice, with different answers.`);
      }
      found.set(event, entry);
    }
  }
  const missing = CODEX_HOOK_EVENTS.filter((event) => !found.has(event));
  if (missing.length) {
    const said = complaints.length ? ` Codex reported: ${complaints.slice(0, 2).join('; ')}` : '';
    return { ok: false, reason: 'hook-missing', detail: `Codex did not list Wanigan's ${missing.join(', ')} hook${missing.length === 1 ? '' : 's'}.${said}` };
  }
  return { ok: true, entries: Object.fromEntries(found) as Record<CodexHookEvent, CodexHookEntry>, others };
}

/** What one app-server run produced, from the process's side. */
export type CodexHookExchange =
  | { outcome: 'answered'; response: unknown }
  | { outcome: 'timeout' | 'no-answer'; detail: string };

export type CodexHookTrust =
  | { state: 'trusted'; hashes: Record<CodexHookEvent, string> }
  | { state: 'unavailable'; reason: 'timeout' | 'no-answer' | 'parse-failure' | 'hook-missing' | 'trust-not-granted'; detail: string };

/**
 * The trust probe's decision, with the process injected.
 *
 * Two runs, because a run's configuration is fixed when it starts. The first
 * defines the hooks and reads back the hash Codex gives each. The second
 * defines them again and trusts those hashes, and only an answer of `trusted`
 * for all six, at the same hashes, is taken as trust: that second run is the
 * live check that the hashes Wanigan will pass produce trust, rather than an
 * assumption that they do.
 */
export async function decideCodexHookTrust(
  exchange: (configArgs: string[]) => Promise<CodexHookExchange>,
): Promise<CodexHookTrust> {
  const first = await exchange(codexHookConfigArgs());
  if (first.outcome !== 'answered') return { state: 'unavailable', reason: first.outcome, detail: first.detail };
  const listed = readCodexHookList(first.response);
  if (!listed.ok) return { state: 'unavailable', reason: listed.reason, detail: listed.detail };
  const hashes = Object.fromEntries(CODEX_HOOK_EVENTS.map((event) => [event, listed.entries[event].hash])) as Record<CodexHookEvent, string>;

  const second = await exchange(codexHookConfigArgs(hashes));
  if (second.outcome !== 'answered') return { state: 'unavailable', reason: second.outcome, detail: second.detail };
  const confirmed = readCodexHookList(second.response);
  if (!confirmed.ok) return { state: 'unavailable', reason: confirmed.reason, detail: confirmed.detail };
  const refused = CODEX_HOOK_EVENTS
    .map((event) => confirmed.entries[event])
    .filter((entry) => entry.trust !== 'trusted' || entry.hash !== hashes[entry.event] || entry.enabled === false);
  if (refused.length) {
    const said = refused.map((entry) => `${entry.event} ${entry.enabled === false ? 'disabled' : entry.hash !== hashes[entry.event] ? 'rehashed' : entry.trust}`);
    return { state: 'unavailable', reason: 'trust-not-granted', detail: `Given its own hashes, Codex read Wanigan's hooks as: ${said.join(', ')}.` };
  }
  return { state: 'trusted', hashes };
}

const TOOL_INPUT_TEXT = ['command', 'description', 'file_path', 'path', 'notebook_path', 'pattern', 'url', 'query'] as const;
const MAX_TEXT = 2000;

/**
 * A Codex hook payload as the event store reads it.
 *
 * Built field by field from an allow-list rather than passed through, because
 * the payload's shape is unverified and the store must never be handed text
 * it would keep. There is no `prompt`, no `message` and no tool response in
 * what comes out: UserPromptSubmit keeps no content, exactly as for Claude,
 * and an unrecognised field is dropped rather than guessed at. A tool's
 * command may arrive as an argv list, so a list of strings is joined into the
 * one line the timeline shows. A payload with nothing readable is still an
 * event: that it happened, and when, is kept.
 */
export function codexHookInput(raw: unknown): { event: string; input: HookInput } {
  const body = isRecord(raw) ? raw : {};
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.slice(0, MAX_TEXT) : undefined;
  const event = codexEventName(body.hook_event_name) ?? 'Unknown';
  const input: HookInput = { hook_event_name: event };
  const toolName = text(body.tool_name);
  if (toolName) input.tool_name = toolName;
  const toolUseId = text(body.tool_use_id) ?? text(body.call_id);
  if (toolUseId) input.tool_use_id = toolUseId;
  if (typeof body.duration_ms === 'number' && Number.isFinite(body.duration_ms)) input.duration_ms = body.duration_ms;
  if (isRecord(body.tool_input)) {
    const toolInput: Record<string, unknown> = {};
    for (const field of TOOL_INPUT_TEXT) {
      const value = body.tool_input[field];
      const joined = Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string')
        ? value.join(' ')
        : value;
      const kept = text(joined);
      if (kept) toolInput[field] = kept;
    }
    input.tool_input = toolInput;
  }
  const response = body.tool_response;
  if (isRecord(response) && response.is_error === true) input.tool_response = { is_error: true };
  return { event, input };
}

/** The dotted version out of a `codex --version` line, or the line when it has none. */
export function codexVersionLabel(line: string | null | undefined): string | null {
  if (typeof line !== 'string' || !line.trim()) return null;
  return /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(line)?.[1] ?? clipped(line, 40);
}

const REASONS: Record<ObserveOnlyHooksReason, string> = {
  'harness-unproven': 'this profile\'s claim to run Codex has not been proven by a trusted adapter',
  'hook-bus-off': 'the hook bus is off in Settings › Privacy & data',
  'listener-down': 'Wanigan\'s hook listener is not running',
  'curl-missing': 'the forwarding command needs /bin/sh and /usr/bin/curl, and one of them is missing',
  'no-version': 'Codex did not report a version, so trust could not be tied to the binary',
  timeout: 'Codex\'s app-server did not answer hooks/list within 10 seconds',
  'no-answer': 'Codex\'s app-server stopped before it answered hooks/list',
  'parse-failure': 'Codex\'s hooks/list answer could not be read',
  'hook-missing': 'Codex did not list all six of Wanigan\'s hooks',
  'trust-not-granted': 'Codex did not trust Wanigan\'s hooks by the hashes it reported',
  'extra-args': 'the session\'s extra arguments configure Codex hooks themselves',
  'launch-failed': 'the session\'s hook credentials could not be written',
};

/** The reason, as a clause that completes "not available: …". */
export function observeOnlyHooksReason(reason: ObserveOnlyHooksReason): string {
  return REASONS[reason];
}

/**
 * The capability line Settings shows for Codex hook events, in the only three
 * shapes it can take. "Trusted" never says an event arrived, and "observed"
 * is only ever built from a first event that was recorded.
 */
export function observeOnlyHooksSentence(status: ObserveOnlyHooks, when: (at: number) => string): string {
  if (status.state === 'observed') return `observed on ${status.version} — first event ${when(status.firstEventAt)}`;
  if (status.state === 'trusted') return `injected and trusted on ${status.version}; no event has arrived yet from a real session`;
  return `not available: ${observeOnlyHooksReason(status.reason)}`;
}
