/**
 * What a headless row actually ended as — finer than succeeded or errored.
 *
 * The row status vocabulary (`succeeded`, `errored`, `timeout`, `canceled`,
 * `blocked`) says whether the process did what a process does. It cannot say
 * the three things an operator acts on differently:
 *
 *  - `waiting_on_input`: the run stopped because it needed a person — Claude's
 *    result object lists `permission_denials`, or stops on a deferred tool
 *    call, or its final message ends on a question; Codex's `turn.failed`
 *    names an approval. "Done" is the wrong word for a run that is waiting.
 *  - `ended_without_result`: the process exited and never printed the terminal
 *    JSON event its protocol promises. Nothing in the output can be trusted
 *    as the run's answer, whatever the exit code said.
 *  - `timed_out`: Wanigan stopped it, and the output it had produced is kept.
 *
 * And one diagnosis that is worth more than a status: a Codex run whose output
 * pairs a DNS or connection failure with an authentication complaint was, in
 * the reported cases, a sandbox with no network in which a CLI's "could not
 * resolve host" was read by the model as "token invalid". That is labelled as
 * a network failure, with the setting that governs it, not an auth failure.
 *
 * Every rule reads recorded output only. The claude result schema used here is
 * the zod schema in the Claude Code 2.1.271 binary (`type:"result"`,
 * `subtype`, `is_error`, `stop_reason`, `permission_denials:[{tool_name,
 * tool_use_id, tool_input}]`, `deferred_tool_use`); the Codex event names are
 * those `codex exec --json` 0.154.0 emits (`thread.started`, `turn.started`,
 * `item.*`, `turn.completed`, `turn.failed`, `error`).
 */

export type HeadlessOutcomeKind =
  | 'succeeded'
  | 'waiting_on_input'
  | 'ended_without_result'
  | 'timed_out'
  | 'network_unreachable'
  | 'errored'
  | 'canceled';

export type HeadlessOutcome = {
  kind: HeadlessOutcomeKind;
  /** A stable reason code, so a surface can explain the verdict without re-deriving it. */
  reason: string;
  /** One sentence for the operator. */
  detail: string;
};

export type HeadlessOutcomeInput = {
  harness: string | null | undefined;
  /** The row status headless.ts already decided. */
  status: 'succeeded' | 'errored' | 'timeout' | 'canceled' | 'blocked' | string;
  stdout: string;
  stderr: string;
  spawnFailed: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const whole = stdout.trim();
  if (!whole) return out;
  try {
    const parsed = JSON.parse(whole) as unknown;
    if (isRecord(parsed)) return [parsed];
  } catch { /* JSONL, or noise around it */ }
  for (const line of whole.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(t) as unknown;
      if (isRecord(parsed)) out.push(parsed);
    } catch { /* partial or non-JSON line */ }
  }
  return out;
}

/** Claude's terminal result object, if the output carried one. */
export function claudeResult(stdout: string): Record<string, unknown> | null {
  const events = jsonLines(stdout);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'result') return events[i];
  }
  return null;
}

type CodexTerminal = { type: 'turn.completed' | 'turn.failed' | 'error'; message: string | null; lastAgentText: string | null };

/** The last terminal event of a `codex exec --json` stream, the one that is authoritative. */
export function codexTerminal(stdout: string): CodexTerminal | null {
  const events = jsonLines(stdout);
  let lastAgentText: string | null = null;
  let terminal: CodexTerminal | null = null;
  for (const event of events) {
    const type = event.type;
    if (type === 'item.completed' && isRecord(event.item) && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
      lastAgentText = event.item.text;
    }
    if (type === 'turn.completed' || type === 'turn.failed' || type === 'error') {
      const error = isRecord(event.error) ? event.error : null;
      const message = typeof error?.message === 'string' ? error.message
        : typeof event.message === 'string' ? event.message : null;
      terminal = { type, message, lastAgentText };
    }
  }
  return terminal ? { ...terminal, lastAgentText } : null;
}

/** The final message's last non-empty line ends with a question mark. */
export function endsOnQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  const lines = text.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return /\?["'”’)\]*_`]*$/.test(last);
}

const NETWORK = /could not resolve host|ENOTFOUND|getaddrinfo|network is unreachable|ENETUNREACH|EAI_AGAIN|failed to connect to|connection refused|ECONNREFUSED|temporary failure in name resolution/gi;
const AUTH = /\b(?:auth(?:entication|orization)?|unauthori[sz]ed|401|403|credentials?|token|log ?in|not logged in|permission denied \(publickey\)|bad credentials|invalid api key)\b/gi;
/** How close a network signature must sit to an auth complaint, in characters. */
export const NETWORK_AUTH_WINDOW = 800;

/** A network failure signature within the window of an auth complaint. */
export function networkBeforeCredentials(text: string): { network: string; auth: string } | null {
  const nets = [...text.matchAll(NETWORK)];
  if (!nets.length) return null;
  const auths = [...text.matchAll(AUTH)];
  for (const net of nets) {
    for (const auth of auths) {
      if (Math.abs((net.index ?? 0) - (auth.index ?? 0)) <= NETWORK_AUTH_WINDOW) {
        return { network: net[0], auth: auth[0] };
      }
    }
  }
  return null;
}

export const NETWORK_SETTING = 'sandbox_workspace_write.network_access';

function kb(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
}

export function classifyHeadlessOutcome(input: HeadlessOutcomeInput): HeadlessOutcome {
  const { harness, status, stdout, stderr } = input;
  if (status === 'canceled') return { kind: 'canceled', reason: 'canceled', detail: 'Canceled before it finished.' };
  if (status === 'blocked') return { kind: 'errored', reason: 'blocked', detail: 'Blocked before an agent started.' };
  if (status === 'timeout') {
    const kept = stdout.trim() ? `partial output kept (${kb(stdout)})` : 'it had printed nothing';
    return { kind: 'timed_out', reason: 'timed-out', detail: `Stopped at the timeout; ${kept}.` };
  }
  if (input.spawnFailed) return { kind: 'errored', reason: 'spawn-failed', detail: 'The agent could not be started.' };

  if (harness === 'codex') {
    const terminal = codexTerminal(stdout);
    const everything = `${stdout}\n${stderr}`;
    const net = networkBeforeCredentials(everything);
    const complained = terminal?.type !== 'turn.completed' || status !== 'succeeded'
      || /\b(auth|token|credential|unauthori[sz]ed|log ?in)\b/i.test(terminal?.lastAgentText ?? '');
    if (net && complained) {
      return {
        kind: 'network_unreachable',
        reason: 'network-before-credentials',
        detail: `Network was unreachable in the sandbox (not an auth failure): "${net.network}" appears next to "${net.auth}". Codex's workspace-write sandbox has no network unless ${NETWORK_SETTING} is enabled.`,
      };
    }
    if (!terminal) {
      return { kind: 'ended_without_result', reason: 'no-terminal-event', detail: 'The process exited without a turn.completed, turn.failed or error event, so nothing it printed is a result.' };
    }
    if (terminal.type !== 'turn.completed') {
      if (/approv|permission|requires? (?:your )?confirmation/i.test(terminal.message ?? '')) {
        return { kind: 'waiting_on_input', reason: 'codex-approval', detail: `The turn failed waiting on an approval: ${(terminal.message ?? '').slice(0, 200)}` };
      }
      return { kind: 'errored', reason: `codex-${terminal.type}`, detail: terminal.message ? terminal.message.slice(0, 300) : `Codex reported ${terminal.type}.` };
    }
    if (endsOnQuestion(terminal.lastAgentText)) {
      return { kind: 'waiting_on_input', reason: 'ended-on-question', detail: 'The final message ends with a question, so the run is waiting on an answer rather than done.' };
    }
    return status === 'succeeded'
      ? { kind: 'succeeded', reason: 'turn-completed', detail: 'Codex reported turn.completed.' }
      : { kind: 'errored', reason: 'exit-code', detail: 'Codex reported turn.completed but the process exited unsuccessfully.' };
  }

  if (harness === 'claude-code') {
    const result = claudeResult(stdout);
    if (!result) {
      return { kind: 'ended_without_result', reason: 'no-result-event', detail: 'The process exited without printing its result object, so nothing it printed is a result.' };
    }
    const denials = Array.isArray(result.permission_denials) ? result.permission_denials.filter(isRecord) : [];
    if (denials.length) {
      const tools = [...new Set(denials.map((d) => (typeof d.tool_name === 'string' ? d.tool_name : 'a tool')))].slice(0, 5);
      return {
        kind: 'waiting_on_input',
        reason: 'permission-denials',
        detail: `The run was denied permission ${denials.length} time${denials.length === 1 ? '' : 's'} (${tools.join(', ')}), so it ended without doing what it needed.`,
      };
    }
    if (result.deferred_tool_use !== undefined || result.stop_reason === 'tool_deferred') {
      return { kind: 'waiting_on_input', reason: 'tool-deferred', detail: 'The run stopped on a tool call deferred for a decision.' };
    }
    if (result.is_error === true || (typeof result.subtype === 'string' && result.subtype.startsWith('error'))) {
      return { kind: 'errored', reason: typeof result.subtype === 'string' ? result.subtype : 'is-error', detail: `Claude reported ${typeof result.subtype === 'string' ? result.subtype : 'an error'}.` };
    }
    if (endsOnQuestion(typeof result.result === 'string' ? result.result : null)) {
      return { kind: 'waiting_on_input', reason: 'ended-on-question', detail: 'The final message ends with a question, so the run is waiting on an answer rather than done.' };
    }
    return status === 'succeeded'
      ? { kind: 'succeeded', reason: 'result-success', detail: 'Claude reported a successful result.' }
      : { kind: 'errored', reason: 'exit-code', detail: 'Claude printed a result but the process exited unsuccessfully.' };
  }

  return status === 'succeeded'
    ? { kind: 'succeeded', reason: 'exit-zero', detail: 'The process exited successfully.' }
    : { kind: 'errored', reason: 'exit-code', detail: 'The process exited unsuccessfully.' };
}

export const OUTCOME_WORDS: Record<HeadlessOutcomeKind, { glyph: string; word: string }> = {
  succeeded: { glyph: '✓', word: 'succeeded' },
  waiting_on_input: { glyph: '?', word: 'waiting on input' },
  ended_without_result: { glyph: '∅', word: 'ended without a result' },
  timed_out: { glyph: '◷', word: 'timed out' },
  network_unreachable: { glyph: '⚠', word: 'network unreachable (not auth)' },
  errored: { glyph: '✕', word: 'errored' },
  canceled: { glyph: '⊘', word: 'canceled' },
};
