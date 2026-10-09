// How hook events become a session's state, and how needs are ranked.
// The rules are carried over from Wanigan 1, where each was earned against the
// shipped Claude Code binary (field names read from its own payload schemas):
//
// - A permission request stands until something answers it. A later notification
//   or lifecycle ping must not quietly clear "needs you" while the prompt is
//   still on screen.
// - SessionEnd with reason `clear` or `resume` is not the end of the process;
//   only the PTY exiting is.
// - Notification carries `notification_type` (permission_prompt, idle_prompt,
//   auth_success, elicitation_dialog) since at least 2.1.292; the message text is
//   a fallback for older binaries, never the first resort.
// - A turn stopped by the account's usage limit is not a finished turn. It is
//   StopFailure with `error: "rate_limit"` and Claude's "You've hit your …"
//   message (see limits.ts). Claude may then wait for the reset and carry on by
//   itself, saying so with the notification types quota_auto_resume_fired,
//   _stale (the reset came; it waits for Enter) and _disabled (it will not).
// - Gemini CLI says it hit a limit only on its screen (limits.ts); Wanigan
//   reads that as its own event, UsageLimit.
import { usageLimitMessage } from './limits.ts';
import { CHATTER_TOOL, chatterLine, chatterOf } from './chatter.ts';
import { NEED_KINDS, type Need, type PermissionAsk, type Provider, type SessionState } from './model.ts';

export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  notification_type?: string;
  message?: string;
  reason?: string;
  session_id?: string;
  /** StopFailure: why the turn stopped ("rate_limit", "server_error", …). */
  error?: string;
  last_assistant_message?: string;
  [key: string]: unknown;
}

const ASKING = /permission|needs your|approve|confirm/i;

/** Events that settle an outstanding permission request: an answer, or the run moving on. */
const ANSWERS = new Set([
  'PermissionDenied', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit',
  'Stop', 'StopFailure', 'SessionStart', 'PreCompact', 'PostCompact', 'ElicitationResult',
]);

/**
 * The state after one hook event. Returns `prev` when the event says nothing
 * about state (an unknown event, a lifecycle ping while asking).
 */
export function nextState(prev: SessionState, event: string, input: HookInput): SessionState {
  if (prev === 'ended' || prev === 'failed' || prev === 'interrupted') return prev;
  switch (event) {
    case 'PermissionRequest':
    case 'Elicitation':
      return 'permission';
    case 'Notification': {
      const type = input.notification_type;
      if (type === 'permission_prompt' || type === 'elicitation_dialog') return 'permission';
      // Sitting idle at the prompt neither answers a question nor lifts a limit.
      if (type === 'idle_prompt') return prev === 'permission' || prev === 'limited' ? prev : 'waiting';
      if (type === 'quota_auto_resume_fired') return 'working';
      if (type === undefined && ASKING.test(String(input.message ?? ''))) return 'permission';
      return prev;
    }
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
    case 'PreCompact':
    case 'PostCompact':
    case 'ElicitationResult':
      return 'working';
    case 'StopFailure':
      return usageLimitMessage(event, input) ? 'limited' : 'waiting';
    // Wanigan's own event: Gemini CLI drew its usage-limit dialog.
    case 'UsageLimit':
      return 'limited';
    case 'SessionStart':
    case 'Stop':
    // Wanigan's own event: the owner said No or pressed Esc, and Claude Code
    // drew its interrupt line (no hook fires for either).
    case 'Interrupted':
      return 'waiting';
    default:
      return ANSWERS.has(event) && prev === 'permission' ? 'working' : prev;
  }
}

/** A short, human line for what a tool call is doing: "Edit app.ts", "Bash npm test". */
export function describeTool(tool: string | undefined, input: unknown): string | null {
  if (!tool) return null;
  // Who it went to and the sender's label for it; never the message itself.
  if (tool === CHATTER_TOOL) return clip(chatterLine(chatterOf(input)), 96);
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const base = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;
  const target =
    (str(i.file_path) && base(str(i.file_path) as string)) ??
    (str(i.notebook_path) && base(str(i.notebook_path) as string)) ??
    str(i.command) ??
    str(i.pattern) ??
    str(i.url) ??
    str(i.query) ??
    str(i.description) ??
    null;
  const line = target ? `${tool} ${target}` : tool;
  return clip(line.replace(/\s+/g, ' '), 96);
}

/** What one event contributes to the session's activity line, or null to leave it. */
export function activityFor(event: string, input: HookInput): string | null {
  switch (event) {
    case 'PreToolUse':
      return describeTool(input.tool_name, input.tool_input);
    case 'PermissionRequest':
      return `Asking: ${describeTool(input.tool_name, input.tool_input) ?? 'permission'}`;
    case 'Notification':
      if (String(input.notification_type ?? '').startsWith('quota_auto_resume')) return input.message ? clip(String(input.message), 120) : null;
      return input.notification_type === 'permission_prompt' || input.notification_type === 'elicitation_dialog'
        ? clip(String(input.message ?? 'Asking for permission'), 96)
        : null;
    case 'UserPromptSubmit':
      return 'Thinking';
    case 'Stop':
      return 'Finished its turn';
    case 'Interrupted':
      return 'Interrupted: back at its prompt';
    case 'StopFailure': {
      const limit = usageLimitMessage(event, input);
      return limit ? clip(limit, 120) : 'Turn failed';
    }
    case 'UsageLimit':
      return typeof input.message === 'string' ? clip(input.message, 120) : 'Hit its usage limit';
    case 'PreCompact':
      return 'Compacting context';
    case 'SessionStart':
      return 'At its prompt';
    default:
      return null;
  }
}

/** A permission request's text is kept up to this long; a longer one is cut and says so. */
export const ASK_MAX_CHARS = 20_000;
/** Requests one session can have open at once (parallel tool calls each ask). */
export const ASKS_MAX = 4;

/**
 * Exactly what a PermissionRequest asks to do, from its own payload: the
 * command for Bash, the file for an edit, the address for a fetch, and the
 * whole input, as JSON, for anything else. Never summarised or collapsed: this
 * is what the owner reads before answering.
 */
export function permissionAsk(tool: unknown, input: unknown): PermissionAsk | null {
  if (typeof tool !== 'string' || !tool) return null;
  const i = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  let what: PermissionAsk['what'] = 'input';
  let text = str(i.command);
  if (text) what = 'command';
  else if ((text = str(i.file_path) ?? str(i.notebook_path))) what = 'path';
  else if ((text = str(i.url))) what = 'address';
  else if (tool === 'ExitPlanMode' && (text = str(i.plan))) what = 'plan';
  else if (tool === 'WebSearch' && (text = str(i.query))) what = 'search';
  else text = input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input, null, 2) ?? '';
  const cut = text.length > ASK_MAX_CHARS;
  return { tool: tool.slice(0, 120), what, text: cut ? text.slice(0, ASK_MAX_CHARS) : text, cut };
}

/**
 * Whether Needs you can answer a need by sending the agent a message, through
 * the queue the session's composer uses. `null` when the need is not one a
 * message answers; otherwise either yes, or no with the reason to show.
 *
 * Claude Code, Gemini CLI, and Codex once its own hooks report: they say when
 * they are idle (the message is sent then) and when a message starts a turn
 * (UserPromptSubmit, Gemini's BeforeAgent), so the row clears on the agent's
 * own evidence. Gemini takes one only after its first turn, as its composer
 * does (the core says so). Codex 0.155.1 fires UserPromptSubmit, with the
 * prompt, for a message pasted in the way the composer types it (seen against
 * the real binary with a stand-in model provider). A question's answer goes on
 * its card, which settles it, and to the agent through the same queue.
 * A Codex read only from its OSC 9 notifications is different: they say a turn
 * ended, never that one began, so Wanigan would have to assume the message
 * landed and clear the row on that assumption. Its question is answered on
 * its card.
 */
export function replyRoute(
  need: Pick<Need, 'kind' | 'sessionId'>,
  session: { provider: Provider; state: SessionState; live: boolean; relayed: boolean } | null,
): { ok: true } | { ok: false; why: string } | null {
  if (need.kind !== 'waiting' && need.kind !== 'question') return null;
  if (!need.sessionId || !session || !session.live || session.provider === 'shell') return null;
  if (session.provider === 'codex' && !session.relayed) {
    return need.kind === 'question' ? null : { ok: false, why: CODEX_NOTIFICATIONS_ONLY };
  }
  return { ok: true };
}

/** Why a Codex session without its hooks gets no Reply. */
export const CODEX_NOTIFICATIONS_ONLY = 'Reply in its terminal: this Codex session reports only through its notifications, which say when a turn ends but never when one starts.';

/** Needs, most urgent kind first, then oldest first within a kind. */
export function rankNeeds(needs: Need[]): Need[] {
  const order = (n: Need): number => NEED_KINDS.indexOf(n.kind);
  return [...needs].sort((a, b) => order(a) - order(b) || a.since - b.since);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
