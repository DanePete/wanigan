// One agent messaging another. Claude Code's SendMessage tool fires PreToolUse
// the moment a message is sent; Wanigan keeps who it went to and the label the
// sender gave it, and never the message. The body is one model's words to
// another: a copy of it would be a transcript of someone else's conversation.
//
// The pair is stored in a session event's summary column as `to · label`. This
// file is the only writer and the only reader of that encoding, so the two
// cannot drift apart (Wanigan 1's writer joined with ' — ' while its reader
// split on ' · ', and every label came back as part of the recipient's name).

export const CHATTER_TOOL = 'SendMessage';
export const CHATTER_SEP = ' · ';
export const MAX_TO = 40;
export const MAX_LABEL = 160;

export interface Chatter {
  /** Who it went to, as the sender named them ("researcher", "main"); null when it did not say. */
  to: string | null;
  /** The sender's own short label for the message; null when it gave none. */
  label: string | null;
}

const oneLine = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s : null;
};

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The recipient and label from a SendMessage call's input. Reads `to` and `summary` only. */
export function chatterOf(toolInput: unknown): Chatter {
  const i = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>;
  const to = oneLine(i.to);
  const label = oneLine(i.summary);
  // The separator cannot appear in the recipient, or the reader would split there.
  return {
    to: to ? clip(to.split(CHATTER_SEP).join(' - '), MAX_TO) : null,
    label: label ? clip(label, MAX_LABEL) : null,
  };
}

/**
 * Which agent inside the session sent it, when it was not the session's main
 * thread. Claude Code puts `agent_id` (and `agent_type`) on hooks that fire from
 * a subagent; without this every reply from a helper would read as the session
 * talking to itself.
 */
export function chatterAgent(hookInput: Readonly<Record<string, unknown>>): string | null {
  if (!oneLine(hookInput.agent_id)) return null;
  const type = oneLine(hookInput.agent_type);
  return type ? clip(type, MAX_TO) : 'a subagent';
}

/** What goes in the summary column. A label may contain the separator; only the first one splits. */
export function encodeChatter(c: Chatter): string {
  return `${c.to ?? ''}${CHATTER_SEP}${c.label ?? ''}`;
}

export function decodeChatter(summary: string | null): Chatter {
  if (!summary) return { to: null, label: null };
  const at = summary.indexOf(CHATTER_SEP);
  if (at < 0) return { to: summary.trim() || null, label: null };
  return {
    to: summary.slice(0, at).trim() || null,
    label: summary.slice(at + CHATTER_SEP.length).trim() || null,
  };
}

/** The activity line: "Messaging researcher: found the flaky test". */
export function chatterLine(c: Chatter): string {
  return `Messaging ${c.to ?? 'another agent'}${c.label ? `: ${c.label}` : ''}`;
}
